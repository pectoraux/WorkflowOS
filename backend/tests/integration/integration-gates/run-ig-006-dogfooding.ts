/**
 * IG-006 standalone dogfood. Uses the real application stack, two real host
 * adapters, real Ed25519 attestations, an independent verifier process and a
 * real node:fs side effect on Node B.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildServer } from '../../../src/api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import { buildTriggerTestStack, type TriggerTestStack, versionContentOf, TRIGGER_TEST_EPOCH } from '../workflow-deployments/trigger-test-support.js';
import {
  ComputerAgentRuntime, WebBrowserHostAdapter, DesktopHostAdapter, RealFilesystemDesktopEnvironment,
  registerComputerHost, ScriptedBrowserEnvironment, type AttestingComputerHost, type ComputerHostAdapter,
  type AgentDecider, type ComputerAgentPolicy, type DependentStepPrecondition,
} from '../../../src/computer-agent/index.js';
import { createWorkflowIrBuilder, computeWorkflowVersionSemanticDigest, parseWorkflowIrDocument, type WorkflowIrDocument, type WorkflowNode } from '../../../src/workflow-ir/index.js';
import { generateAttesterKeyPair, parseAttestation, serializeAttestation, verifyAttestation, InMemoryReplayRegistry, InMemoryAttestationLedger, type AttesterKeyPair, type VerifiedExecutionFact } from '../../../src/execution-attestation/index.js';
import type { FastifyInstance } from 'fastify';

const API_KEY = 'ig-006-dogfood-key';
const OPERATOR_EXTERNAL_ID = 'ig-006-dogfood-operator';
const FORM_URL = 'https://dogfood.example/intake';
const ACK_PATH = 'reports/ack.md';
const ACK_CONTENT = 'ACK: intake form submitted and attested across devices';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function workflow(): WorkflowIrDocument {
  const collect: WorkflowNode = {
    id: 'collect', executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Submit the intake form through the browser' },
    capabilityRequirements: ['browser.observe', 'browser.click'], placement: 'cloud_allowed',
    inputs: [{ name: 'formUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'formUrl' } }],
    outputs: [{ name: 'submitted', type: { kind: 'boolean' } }], failurePolicy: { strategy: 'fail_workflow' }, completionEvidence: 'observation',
  };
  const approve: WorkflowNode = {
    id: 'approve', executionClass: 'human',
    spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve the cross-device handoff.' } },
    capabilityRequirements: [], placement: 'device_local', inputs: [], outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' }, completionEvidence: 'human_confirmation',
  };
  const record: WorkflowNode = {
    id: 'record_ack', executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Write the acknowledgment report on the local device' },
    capabilityRequirements: ['filesystem.read', 'filesystem.write'], placement: 'device_local',
    inputs: [
      { name: 'ackPath', type: { kind: 'string' }, binding: { kind: 'literal', value: ACK_PATH } },
      { name: 'ackContent', type: { kind: 'string' }, binding: { kind: 'literal', value: ACK_CONTENT } },
    ],
    outputs: [{ name: 'written', type: { kind: 'boolean' } }], failurePolicy: { strategy: 'fail_workflow' }, completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder().withStart('collect').addWorkflowInput({ name: 'formUrl', type: { kind: 'string' } })
    .addNode(collect).addNode(approve).addNode(record)
    .addEdge({ from: 'collect', to: 'approve', on: 'success' })
    .addEdge({ from: 'approve', to: 'record_ack', on: { outcome: 'approved' } }).build();
}

class CapturingHost implements AttestingComputerHost {
  readonly nodeId: string; readonly sessionToken: string; readonly platformClass: AttestingComputerHost['platformClass'];
  readonly capabilities: ComputerHostAdapter['capabilities'];
  readonly attestationSupport: { readonly supported: true; readonly attesterKeyId: string };
  private readonly inner: AttestingComputerHost; private readonly captured: ReturnType<AttestingComputerHost['signStatement']>[] = [];
  constructor(inner: ComputerHostAdapter) {
    if (!inner.attestationSupport.supported || typeof (inner as AttestingComputerHost).signStatement !== 'function') throw new Error('attesting host required');
    this.inner = inner as AttestingComputerHost; this.nodeId = inner.nodeId; this.sessionToken = inner.sessionToken; this.platformClass = inner.platformClass;
    this.capabilities = inner.capabilities; this.attestationSupport = inner.attestationSupport;
  }
  get attestations() { return [...this.captured]; }
  invoke(...args: Parameters<ComputerHostAdapter['invoke']>) { return this.inner.invoke(...args); }
  nextNonce() { return this.inner.nextNonce(); }
  signStatement(...args: Parameters<AttestingComputerHost['signStatement']>) { const a = this.inner.signStatement(...args); this.captured.push(a); return a; }
}

const BROWSER_CAPS = [
  { name: 'browser.observe', version: 1, availability: 'available' as const },
  { name: 'browser.click', version: 1, availability: 'available' as const },
];
const FILE_CAPS = [
  { name: 'filesystem.read', version: 1, availability: 'available' as const },
  { name: 'filesystem.write', version: 1, availability: 'available' as const },
];

function browserDecider(): AgentDecider {
  return (ctx) => {
    if (!ctx.observation) return { decision: 'observe', capability: 'browser.observe', subject: FORM_URL };
    if (!ctx.history.some((r) => r.capability === 'browser.click' && r.ok)) {
      const target = ctx.observation.elements.find((e) => e.elementId === 'btn-submit');
      return { decision: 'act', capability: 'browser.click', grounding: target ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest } : null, parameters: {} };
    }
    return { decision: 'complete', verify: { capability: 'browser.observe', subject: FORM_URL, expect: { elementId: 'btn-submit', state: 'clicked' } }, outputs: { submitted: true } };
  };
}
function ackDecider(): AgentDecider {
  return (ctx) => {
    if (!ctx.observation) return { decision: 'observe', capability: 'filesystem.read', subject: ACK_PATH };
    if (!ctx.history.some((r) => r.capability === 'filesystem.write' && r.ok)) {
      const target = ctx.observation.elements.find((e) => e.elementId === ACK_PATH);
      return { decision: 'act', capability: 'filesystem.write', grounding: target ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest } : null, parameters: { path: ACK_PATH, content: ACK_CONTENT } };
    }
    return { decision: 'complete', verify: { capability: 'filesystem.read', subject: ACK_PATH, expect: { elementId: ACK_PATH, state: ACK_CONTENT } }, outputs: { written: true } };
  };
}

function runtime(support: TriggerTestStack, nodes: TriggerTestStack['nodes'], policy: ComputerAgentPolicy) {
  return new ComputerAgentRuntime({ recorder: support.runs, nodes, workflowRepository: support.repository, clock: () => support.clock.utc(), epoch: TRIGGER_TEST_EPOCH, policy, replayRegistry: new InMemoryReplayRegistry() });
}

function independentVerifierSource(barrelUrl: string) {
  return `import { readFileSync } from 'node:fs';\nconst barrel = await import(${JSON.stringify(barrelUrl)});\nconst att = barrel.parseAttestation(readFileSync(process.argv[2], 'utf8'));\nconst ctx = JSON.parse(readFileSync(process.argv[3], 'utf8'));\nif (!att.ok) { console.log(JSON.stringify({ ok:false, code:att.failure.code })); process.exit(0); }\nconst v = barrel.verifyAttestation(att.attestation,{bindings:ctx.bindings,freshness:{now:ctx.now,currentEpoch:ctx.epoch,replayRegistry:new barrel.InMemoryReplayRegistry()},attesterKeyIds:ctx.attesterKeyIds});\nconsole.log(JSON.stringify(v.ok ? {ok:true,fact:v.fact} : {ok:false,code:v.failure.code}));\n`;
}

async function experiment(): Promise<Record<string, unknown>> {
  const support = await buildTriggerTestStack({ WFOS_IG_006_DOGFOODING_KEY: API_KEY });
  const temp = mkdtempSync(join(tmpdir(), 'ig6-dogfood-')); mkdirSync(join(temp, 'reports'), { recursive: true });
  const operator = await support.stack.userRepository.upsertByExternalId({ externalId: OPERATOR_EXTERNAL_ID, displayName: 'IG-006 Dogfood Operator' });
  const org = await support.stack.organizationRepository.create({ name: 'IG-006 Dogfood Org' });
  await support.stack.membershipRepository.assign({ userId: operator.id, organizationId: org.id, roleId: 'owner' });
  const provisioner = new ApiKeyCredentialProvisioner(support.stack.db.client);
  await provisioner.provision({ keyId: 'ig6-dogfood-key-id', secretRef: 'WFOS_IG_006_DOGFOODING_KEY', externalId: OPERATOR_EXTERNAL_ID, label: 'IG-006 Dogfood', rawKey: API_KEY });
  const authProvider = new ApiKeyAuthProvider(support.stack.db.client, new EnvSecretStore());
  const app: FastifyInstance = await buildServer({ queue: new InMemoryQueue(), logger: createLogger({ level: 'silent' }), auth: { authProvider, userRepository: support.stack.userRepository }, workflowRepository: { workflowRepositoryService: support.repository }, workflowRuns: { workflowRunService: support.runs }, workflowDeployments: { workflowDeploymentService: support.deployments } });
  await app.ready();
  try {
    const inject = async (method: 'GET'|'POST', url: string, payload?: unknown) => { const r = await app.inject({ method, url, headers: payload === undefined ? { authorization: `Bearer ${API_KEY}` } : { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, payload: payload as Record<string, unknown>|undefined }); return { status:r.statusCode, body:(r.json()??{}) as Record<string,unknown>, raw:r.body }; };
    const nodes = support.nodes;
    const keyA = generateAttesterKeyPair(); const keyB = generateAttesterKeyPair();
    const browser = new ScriptedBrowserEnvironment([{ url: FORM_URL, elements: [{ elementId:'btn-submit', kind:'button', label:'Submit', state:'enabled' }] }]);
    const fsHost = new RealFilesystemDesktopEnvironment({ root: temp });
    const regA = registerComputerHost({ nodes, keySeed:'ig6-dogfood-A', platformClass:'web', capabilities:BROWSER_CAPS });
    const regB = registerComputerHost({ nodes, keySeed:'ig6-dogfood-B', platformClass:'desktop', capabilities:FILE_CAPS });
    const hostA = new CapturingHost(new WebBrowserHostAdapter({ nodeId:regA.nodeId, sessionToken:regA.sessionToken, clock:()=>support.clock.utc(), capabilities:BROWSER_CAPS, attestation:{supported:true,attesterKeyId:keyA.keyId}, attesterKey:keyA, environment:browser }));
    const hostB = new CapturingHost(new DesktopHostAdapter({ nodeId:regB.nodeId, sessionToken:regB.sessionToken, clock:()=>support.clock.utc(), capabilities:FILE_CAPS, attestation:{supported:true,attesterKeyId:keyB.keyId}, attesterKey:keyB, environment:fsHost }));
    const create = await inject('POST', `/organizations/${org.id}/workflow-repository/workflows`, { slug:'ig6-dogfood', name:'IG-006 Dogfood', description:'cross-device', visibility:'private', content:versionContentOf(workflow()), protocol:{irSchemaVersion:'workflowos-workflow-ir-v1'} });
    const created = create.body as unknown as { workflow:{id:string}; initialVersion:{id:string;contentDigest:string;versionNumber:number} };
    if (create.status !== 201) throw new Error(`create failed: ${create.raw}`);
    const install = await inject('POST', `/organizations/${org.id}/workflow-repository/installations`, { workflowId:created.workflow.id, versionId:created.initialVersion.id });
    const installation = (install.body as unknown as { installation:{id:string;status:string} }).installation;
    if (install.status !== 201 || installation.status !== 'enabled') throw new Error(`install failed: ${install.raw}`);
    const version = await inject('GET', `/workflow-repository/workflows/${created.workflow.id}/versions/${created.initialVersion.id}`);
    const parsed = parseWorkflowIrDocument(JSON.stringify((version.body as unknown as {version:{content:Record<string,unknown>}}).version.content));
    if (!parsed.ok) throw new Error('parse failed');
    const semanticDigest = computeWorkflowVersionSemanticDigest(parsed.document).digest;
    const { deployment } = await support.deployments.createDeployment({ userId:operator.id }, { organizationId:org.id, workflowId:created.workflow.id, versionId:created.initialVersion.id, installationId:installation.id, name:'ig6-dogfood-deployment', placement:{placement:{required:'cloud_allowed'},privacy:{localOnly:false}} });
    const { subscription } = await support.deployments.createSubscription({ userId:operator.id }, { deploymentId:deployment.id, kind:'event', eventPattern:{eventType:'file.changed'} });
    const event = await inject('POST', `/organizations/${org.id}/workflow-deployments/events`, { source:hostA.nodeId, eventId:'ig6-dogfood-event', eventType:'file.changed', payload:{path:'inbox/intake-form.txt'} });
    const delivery = (event.body as unknown as {deliveries:{runId:string|null;state:string}[]}).deliveries[0]!;
    const runId = delivery.runId!;
    if (delivery.state !== 'delivered') throw new Error('event delivery failed');
    const reportA = await runtime(support,nodes,{ maxActionsPerStep:12,maxObservationAgeMs:60000,maxRecoveryCyclesPerStep:4,safeAction:{grants:[{capability:'browser.observe',scope:'run'},{capability:'browser.click',scope:'run'},{capability:'filesystem.read',scope:'run'},{capability:'filesystem.write',scope:'run'}]},attestation:{required:true,trustedAttesterKeyIds:[keyA.keyId],validityMs:300000} }).executeRun({userId:operator.id},{runId,hosts:[hostA],decider:browserDecider(),workflowInputs:{formUrl:FORM_URL}});
    if (reportA.state !== 'paused') throw new Error(`Node A did not pause: ${reportA.state}`);
    const historyA = await support.runs.getRunHistory({userId:operator.id},runId); const durableA = historyA.attestations.find((b)=>b.stepId==='collect')!; const attestationA=hostA.attestations[0]!;
    const transfer = join(temp,'attestation-node-a.json'); writeFileSync(transfer,serializeAttestation(attestationA),'utf8');
    const context = join(temp,'verifier-context.json'); writeFileSync(context,JSON.stringify({ bindings:{workflowId:created.workflow.id,workflowVersionId:created.initialVersion.id,workflowVersionSemanticDigest:semanticDigest,deploymentId:installation.id,runId,attemptId:1,stepId:'collect'}, now:support.clock.utc(), epoch:TRIGGER_TEST_EPOCH, attesterKeyIds:[keyA.keyId] }), 'utf8');
    const verifierScript = join(temp,'independent-verifier.mts'); writeFileSync(verifierScript,independentVerifierSource(pathToFileURL(join(process.cwd(),'src/execution-attestation/index.ts')).href),'utf8');
    const child = spawnSync('bunx',['tsx',verifierScript,transfer,context],{cwd:join(process.cwd()),encoding:'utf8'});
    const childResult = JSON.parse((child.stdout??'').trim().split('\n').filter(Boolean).pop()??'null') as {ok:boolean;fact?:VerifiedExecutionFact;code?:string};
    if (child.status !== 0 || !childResult.ok || !childResult.fact) throw new Error(`independent verifier failed: ${child.stdout}\n${child.stderr}`);
    const fact = childResult.fact;
    const precondition: DependentStepPrecondition = { dependentStepId:'record_ack', predecessorAttestationId:fact.attestationId, verifiedPredecessor:fact, causalParentDigests:[durableA.executionDigest], runId, workflowVersionId:created.initialVersion.id, workflowVersionSemanticDigest:semanticDigest };
    const reportB = await runtime(support,nodes,{ maxActionsPerStep:12,maxObservationAgeMs:60000,maxRecoveryCyclesPerStep:4,safeAction:{grants:[{capability:'browser.observe',scope:'run'},{capability:'browser.click',scope:'run'},{capability:'filesystem.read',scope:'run'},{capability:'filesystem.write',scope:'run'}]},attestation:{required:true,trustedAttesterKeyIds:[keyA.keyId,keyB.keyId],validityMs:3600000},dependentStepIds:['record_ack'] }).resumeAfterHuman({userId:operator.id},{runId,hosts:[hostB],humanOutcome:'approved',humanUserId:operator.id,decider:ackDecider(),preconditions:[precondition]});
    if (reportB.state !== 'completed' || !existsSync(join(temp,ACK_PATH)) || readFileSync(join(temp,ACK_PATH),'utf8') !== ACK_CONTENT) throw new Error('Node B dependent side effect failed');
    const history = await support.runs.getRunHistory({userId:operator.id},runId); const durableB=history.attestations.find((b)=>b.stepId==='record_ack')!;
    if (JSON.stringify(durableB.statement.causalParents) !== JSON.stringify([durableA.executionDigest])) throw new Error('runtime causal parent mismatch');
    const causal = verifyAttestation(hostB.attestations[0]!,{bindings:{runId,attemptId:1,stepId:'record_ack',causalParents:[durableA.executionDigest]},freshness:{now:support.clock.utc(),currentEpoch:TRIGGER_TEST_EPOCH,replayRegistry:new InMemoryReplayRegistry()},attesterKeyIds:[keyB.keyId]});
    if (!causal.ok) throw new Error(`dependent attestation does not independently verify: ${causal.failure.code}`);
    const inbox = new InMemoryAttestationLedger(); const d1=inbox.ingest(attestationA,support.clock.utc()); const d2=inbox.ingest(attestationA,support.clock.utc());
    if (d1.kind!=='accepted'||d2.kind!=='duplicate'||d2.deliveries!==2) throw new Error('duplicate handoff did not converge');
    const duplicate = await support.runs.attachAttestation({userId:operator.id},{commandId:`cmd-agent-${runId}-att-${attestationA.attestationId}`,correlationId:`agent-${runId}`},{runId,attemptNumber:1,stepId:'collect',attestation:attestationA,policy:{trustedAttesterKeyIds:[keyA.keyId]}});
    if (duplicate.executed) throw new Error('duplicate attach executed');
    const normalized = { versionContentDigest:created.initialVersion.contentDigest, semanticDigest, runState:history.run.state, steps:history.steps.map(s=>[s.stepId,s.status]), invocations:history.invocations.map(i=>i.capability), evidence:history.evidence.map(e=>e.evidenceClass).sort(), nodes:history.attestations.map(a=>a.statement.nodeId).sort(), causalParent:durableB.statement.causalParents, ack:readFileSync(join(temp,ACK_PATH),'utf8'), replayAfterDuplicate:duplicate.executed };
    await app.close(); await support.teardown();
    return normalized;
  } catch (error) { await app.close(); await support.teardown(); throw error; }
}

const first = await experiment();
const second = await experiment();
const stableFirst = JSON.stringify(first); const stableSecond = JSON.stringify(second);
console.log(JSON.stringify({ checks: [
  ['complete-cross-device', first.runState === 'completed'],
  ['two-host-attestations', Array.isArray(first.nodes) && first.nodes.length === 2],
  ['causal-parent-runtime-produced', Array.isArray(first.causalParent) && first.causalParent.length === 1],
  ['real-filesystem-effect', first.ack === ACK_CONTENT],
  ['deterministic-core-transcript', stableFirst === stableSecond],
], facts: first, transcriptSha256: sha256(stableFirst) }, null, 2));
if (stableFirst !== stableSecond || first.runState !== 'completed' || first.ack !== ACK_CONTENT || first.causalParent.length !== 1) process.exit(1);

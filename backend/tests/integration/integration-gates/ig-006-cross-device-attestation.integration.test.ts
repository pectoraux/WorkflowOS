/**
 * IG-006 — Cross-Device Execution Attestation Composition.
 *
 * Frozen scope: integration proof only. This gate consumes the merged public
 * contracts of V2-005, V2-008, V2-009 and V2-014. It never changes sibling
 * implementation semantics and never creates a second execution,
 * authorization, verification or proof-graph authority.
 *
 * Re-proof lineage: main@11d6afbf (V2-016). The historical blocked PR #152
 * remains untouched and is not rebased.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildServer } from '../../../src/api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import {
  buildTriggerTestStack,
  createTenant,
  versionContentOf,
  TRIGGER_TEST_EPOCH,
  type TriggerTestStack,
} from '../workflow-deployments/trigger-test-support.js';
import {
  ComputerAgentRuntime,
  WebBrowserHostAdapter,
  DesktopHostAdapter,
  registerComputerHost,
  ScriptedBrowserEnvironment,
  ScriptedDesktopEnvironment,
  type AgentDecider,
  type AttestingComputerHost,
  type ComputerAgentPolicy,
  type ComputerHostAdapter,
  type DependentStepPrecondition,
} from '../../../src/computer-agent/index.js';
import {
  generateAttesterKeyPair,
  parseAttestation,
  serializeAttestation,
  verifyAttestation,
  InMemoryReplayRegistry,
  InMemoryAttestationLedger,
  type AttesterKeyPair,
} from '../../../src/execution-attestation/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../../src/workflow-ir/index.js';
import { createWorkflowIrBuilder, computeWorkflowVersionSemanticDigest, parseWorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import type { FastifyInstance } from 'fastify';
import type { WorkflowRunHistory } from '../../../src/workflow-runs/index.js';

const API_KEY = 'ig-006-api-test-key';
const OPERATOR_EXTERNAL_ID = 'ig-006-api-operator';
const FORM_URL = 'https://integration.example/intake';
const ACK_PATH = 'reports/ack.md';
const ACK_CONTENT = 'ACK: intake form submitted and attested across devices';
const CLOUD_CAPS = [
  { name: 'browser.observe', version: 1, availability: 'available' as const },
  { name: 'browser.click', version: 1, availability: 'available' as const },
];
const FILE_CAPS = [
  { name: 'filesystem.read', version: 1, availability: 'available' as const },
  { name: 'filesystem.write', version: 1, availability: 'available' as const },
];

let support: TriggerTestStack;
let app: FastifyInstance;
let operatorUserId: string;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

beforeAll(async () => {
  support = await buildTriggerTestStack({ WFOS_IG_006_API_TEST_KEY: API_KEY });
  const operator = await support.stack.userRepository.upsertByExternalId({
    externalId: OPERATOR_EXTERNAL_ID,
    displayName: 'IG-006 API Operator',
  });
  operatorUserId = operator.id;
  await support.stack.membershipRepository.assign({
    userId: operator.id,
    organizationId: (await createTenant(support, 'ig6-owner')).organizationId,
    roleId: 'owner',
  });
  // Reuse the real stack's operator identity; API-key provisioning exercises the
  // same auth path as the product route tests.
  const provisioner = new ApiKeyCredentialProvisioner(support.stack.db.client);
  await provisioner.provision({
    keyId: 'ig-006-api-test-key-id',
    secretRef: 'WFOS_IG_006_API_TEST_KEY',
    externalId: OPERATOR_EXTERNAL_ID,
    label: 'IG-006 API Operator',
    rawKey: API_KEY,
  });
  const authProvider = new ApiKeyAuthProvider(support.stack.db.client, new EnvSecretStore());
  app = await buildServer({
    queue: new InMemoryQueue(),
    logger: createLogger({ level: 'silent' }),
    auth: { authProvider, userRepository: support.stack.userRepository },
    workflowRepository: { workflowRepositoryService: support.repository },
    workflowRuns: { workflowRunService: support.runs },
    workflowDeployments: { workflowDeploymentService: support.deployments },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await support.teardown();
});

async function injectJson(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await app.inject({
    method,
    url,
    headers: payload === undefined
      ? { authorization: `Bearer ${API_KEY}` }
      : { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    payload: payload as Record<string, unknown> | undefined,
  });
  return { status: response.statusCode, body: (response.json() ?? {}) as Record<string, unknown>, raw: response.body };
}

async function freshTenant(label: string) {
  const tenant = await createTenant(support, `ig6-${label}`);
  await support.stack.membershipRepository.assign({ userId: operatorUserId, organizationId: tenant.organizationId, roleId: 'owner' });
  return { organizationId: tenant.organizationId, principal: { userId: operatorUserId } };
}

function crossDeviceDocument(): WorkflowIrDocument {
  const collect: WorkflowNode = {
    id: 'collect',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Submit the intake form through the browser' },
    capabilityRequirements: ['browser.observe', 'browser.click'],
    placement: 'cloud_allowed',
    inputs: [{ name: 'formUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'formUrl' } }],
    outputs: [{ name: 'submitted', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const approve: WorkflowNode = {
    id: 'approve',
    executionClass: 'human',
    spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve the cross-device handoff.' } },
    capabilityRequirements: [],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'human_confirmation',
  };
  const recordAck: WorkflowNode = {
    id: 'record_ack',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Write the acknowledgment report on the local device' },
    capabilityRequirements: ['filesystem.read', 'filesystem.write'],
    placement: 'device_local',
    inputs: [
      { name: 'ackPath', type: { kind: 'string' }, binding: { kind: 'literal', value: ACK_PATH } },
      { name: 'ackContent', type: { kind: 'string' }, binding: { kind: 'literal', value: ACK_CONTENT } },
    ],
    outputs: [{ name: 'written', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('collect')
    .addWorkflowInput({ name: 'formUrl', type: { kind: 'string' } })
    .addNode(collect)
    .addNode(approve)
    .addNode(recordAck)
    .addEdge({ from: 'collect', to: 'approve', on: 'success' })
    .addEdge({ from: 'approve', to: 'record_ack', on: { outcome: 'approved' } })
    .build();
}

function localAckDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('record_ack')
    .addNode({
      id: 'record_ack',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Write the acknowledgment report on the local device' },
      capabilityRequirements: ['filesystem.read', 'filesystem.write'],
      placement: 'device_local',
      inputs: [
        { name: 'ackPath', type: { kind: 'string' }, binding: { kind: 'literal', value: ACK_PATH } },
        { name: 'ackContent', type: { kind: 'string' }, binding: { kind: 'literal', value: ACK_CONTENT } },
      ],
      outputs: [{ name: 'written', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .build();
}

class CapturingHost implements AttestingComputerHost {
  readonly nodeId: string;
  readonly sessionToken: string;
  readonly platformClass: AttestingComputerHost['platformClass'];
  readonly capabilities: readonly typeof FILE_CAPS;
  readonly attestationSupport: { readonly supported: true; readonly attesterKeyId: string };
  private readonly inner: AttestingComputerHost;
  private readonly capturedAttestations: ReturnType<AttestingComputerHost['signStatement']>[] = [];

  constructor(inner: ComputerHostAdapter) {
    if (!inner.attestationSupport.supported || typeof (inner as AttestingComputerHost).signStatement !== 'function') {
      throw new Error('attesting host required');
    }
    this.inner = inner as AttestingComputerHost;
    this.nodeId = inner.nodeId;
    this.sessionToken = inner.sessionToken;
    this.platformClass = inner.platformClass;
    this.capabilities = inner.capabilities as readonly typeof FILE_CAPS;
    this.attestationSupport = inner.attestationSupport;
  }

  get attestations() {
    return [...this.capturedAttestations];
  }

  invoke(invocationId: string, request: Parameters<ComputerHostAdapter['invoke']>[1]) {
    return this.inner.invoke(invocationId, request);
  }

  nextNonce() {
    return this.inner.nextNonce();
  }

  signStatement(statement: Parameters<AttestingComputerHost['signStatement']>[0], issuedAt: string) {
    const attestation = this.inner.signStatement(statement, issuedAt);
    this.capturedAttestations.push(attestation);
    return attestation;
  }
}

function attachWebHost(key: AttesterKeyPair, environment: ScriptedBrowserEnvironment, nodes = support.nodes): CapturingHost {
  const registration = registerComputerHost({ nodes, keySeed: `ig6-a-${key.keyId}`, platformClass: 'web', capabilities: CLOUD_CAPS });
  return new CapturingHost(new WebBrowserHostAdapter({
    nodeId: registration.nodeId,
    sessionToken: registration.sessionToken,
    clock: () => support.clock.utc(),
    capabilities: CLOUD_CAPS,
    attestation: { supported: true, attesterKeyId: key.keyId },
    attesterKey: key,
    environment,
  }));
}

function attachDesktopHost(key: AttesterKeyPair, environment: ScriptedDesktopEnvironment, nodes = support.nodes): CapturingHost {
  const registration = registerComputerHost({ nodes, keySeed: `ig6-b-${key.keyId}`, platformClass: 'desktop', capabilities: FILE_CAPS });
  return new CapturingHost(new DesktopHostAdapter({
    nodeId: registration.nodeId,
    sessionToken: registration.sessionToken,
    clock: () => support.clock.utc(),
    capabilities: FILE_CAPS,
    attestation: { supported: true, attesterKeyId: key.keyId },
    attesterKey: key,
    environment,
  }));
}

function runtime(
  nodes: TriggerTestStack['nodes'],
  attestation: ComputerAgentPolicy['attestation'],
  dependentStepIds: readonly string[] = [],
): ComputerAgentRuntime {
  return new ComputerAgentRuntime({
    recorder: support.runs,
    nodes,
    workflowRepository: support.repository,
    clock: () => support.clock.utc(),
    epoch: TRIGGER_TEST_EPOCH,
    policy: {
      maxActionsPerStep: 12,
      maxObservationAgeMs: 60_000,
      maxRecoveryCyclesPerStep: 4,
      safeAction: { grants: [
        { capability: 'browser.observe', scope: 'run' },
        { capability: 'browser.click', scope: 'run' },
        { capability: 'filesystem.read', scope: 'run' },
        { capability: 'filesystem.write', scope: 'run' },
      ] },
      attestation,
      dependentStepIds,
    },
    replayRegistry: new InMemoryReplayRegistry(),
  });
}

function browserDecider(): AgentDecider {
  return (ctx) => {
    if (ctx.observation === null) return { decision: 'observe', capability: 'browser.observe', subject: FORM_URL };
    const clicked = ctx.history.some((r) => r.capability === 'browser.click' && r.ok);
    if (!clicked) {
      const target = ctx.observation.elements.find((e) => e.elementId === 'btn-submit');
      return {
        decision: 'act', capability: 'browser.click',
        grounding: target ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest } : null,
        parameters: {},
      };
    }
    return { decision: 'complete', verify: { capability: 'browser.observe', subject: FORM_URL, expect: { elementId: 'btn-submit', state: 'clicked' } }, outputs: { submitted: true } };
  };
}

function ackDecider(): AgentDecider {
  return (ctx) => {
    if (ctx.observation === null) return { decision: 'observe', capability: 'filesystem.read', subject: ACK_PATH };
    const wrote = ctx.history.some((r) => r.capability === 'filesystem.write' && r.ok);
    if (!wrote) {
      const target = ctx.observation.elements.find((e) => e.elementId === ACK_PATH);
      return {
        decision: 'act', capability: 'filesystem.write',
        grounding: target ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest } : null,
        parameters: { path: ACK_PATH, content: ACK_CONTENT },
      };
    }
    return { decision: 'complete', verify: { capability: 'filesystem.read', subject: ACK_PATH, expect: { elementId: ACK_PATH, state: ACK_CONTENT } }, outputs: { written: true } };
  };
}

async function createWorkflow(tenant: { organizationId: string }, slug: string, document: WorkflowIrDocument) {
  const created = await injectJson('POST', `/organizations/${tenant.organizationId}/workflow-repository/workflows`, {
    slug, name: 'IG-006 cross-device workflow', description: 'web -> human -> device-local', visibility: 'private',
    content: versionContentOf(document), protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
  });
  expect(created.status, created.raw).toBe(201);
  const body = created.body as unknown as { workflow: { id: string }; initialVersion: { id: string; versionNumber: number; contentDigest: string } };
  return body;
}

async function requestRun(tenant: { organizationId: string }, workflowId: string, versionId: string, id: string) {
  const requested = await support.runs.requestRun(tenant as never, { commandId: `cmd-${id}`, correlationId: `corr-${id}` }, {
    organizationId: tenant.organizationId, workflowId, versionId, trigger: { type: 'manual', id }, inputCommitments: [sha256(id)],
  });
  return requested.result.run;
}

describe('IG-006 — cross-device execution attestation composition after V2-016', () => {
  it('proves the complete cross-device path, including admission consumption and runtime causal binding (P1-P9)', async () => {
    const tenant = await freshTenant('main');
    const nodes = support.freshNodes();
    const keyA = generateAttesterKeyPair();
    const keyB = generateAttesterKeyPair();
    const browser = new ScriptedBrowserEnvironment([{ url: FORM_URL, elements: [
      { elementId: 'btn-submit', kind: 'button', label: 'Submit', state: 'enabled' },
      { elementId: 'input-notes', kind: 'input', label: 'Notes', state: '' },
    ] }]);
    const desktop = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const hostA = attachWebHost(keyA, browser, nodes);
    const hostB = attachDesktopHost(keyB, desktop, nodes);

    const created = await createWorkflow(tenant, 'ig6-complete', crossDeviceDocument());
    const install = await injectJson('POST', `/organizations/${tenant.organizationId}/workflow-repository/installations`, { workflowId: created.workflow.id, versionId: created.initialVersion.id });
    expect(install.status, install.raw).toBe(201);
    const installation = (install.body as unknown as { installation: { id: string; versionId: string; status: string } }).installation;
    expect(installation.versionId).toBe(created.initialVersion.id);
    expect(installation.status).toBe('enabled');

    const versionRead = await injectJson('GET', `/workflow-repository/workflows/${created.workflow.id}/versions/${created.initialVersion.id}`);
    expect(versionRead.status).toBe(200);
    const parsed = parseWorkflowIrDocument(JSON.stringify((versionRead.body as unknown as { version: { content: Record<string, unknown> } }).version.content));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('version parse failed');
    const semanticDigest = computeWorkflowVersionSemanticDigest(parsed.document).digest;
    const { deployment } = await support.deployments.createDeployment(tenant.principal, {
      organizationId: tenant.organizationId, workflowId: created.workflow.id, versionId: created.initialVersion.id,
      installationId: installation.id, name: 'ig6-complete-deployment', placement: { placement: { required: 'cloud_allowed' }, privacy: { localOnly: false } },
    });
    const { subscription } = await support.deployments.createSubscription(tenant.principal, { deploymentId: deployment.id, kind: 'event', eventPattern: { eventType: 'file.changed' } });

    const eventPayload = { source: hostA.nodeId, eventId: 'ig6-event-001', eventType: 'file.changed', payload: { path: 'inbox/intake-form.txt' } };
    const first = await injectJson('POST', `/organizations/${tenant.organizationId}/workflow-deployments/events`, eventPayload);
    expect(first.status, first.raw).toBe(201);
    const firstEvent = (first.body as unknown as { event: { id: string; payloadCommitment: string } }).event;
    const delivery = (first.body as unknown as { deliveries: { runId: string | null; state: string }[] }).deliveries[0]!;
    const runId = delivery.runId!;
    expect(delivery.state).toBe('delivered');
    const run = await support.runs.getRun(tenant.principal, runId);
    expect(run.workflowId).toBe(created.workflow.id);
    expect(run.versionId).toBe(created.initialVersion.id);
    expect(run.versionContentDigest).toBe(created.initialVersion.contentDigest);
    expect(run.versionSemanticDigest).toBe(semanticDigest);
    expect(run.trigger.id).toBe(`evt:${firstEvent.id}:${subscription.id}`);
    expect(run.inputCommitments).toEqual([firstEvent.payloadCommitment]);

    const duplicateEvent = await injectJson('POST', `/organizations/${tenant.organizationId}/workflow-deployments/events`, eventPayload);
    expect(duplicateEvent.status).toBe(200);
    expect(duplicateEvent.body.created).toBe(false);
    expect((duplicateEvent.body as unknown as { deliveries: unknown[] }).deliveries).toHaveLength(0);

    registerComputerHost({ nodes, keySeed: 'ig6-cloud-relay', platformClass: 'cloud', capabilities: FILE_CAPS });
    const placement = nodes.matchNodes({ id: 'step:record_ack', capabilities: [{ name: 'filesystem.read' }, { name: 'filesystem.write' }], placement: { required: 'device_local' }, minTrustTier: 'provisional' });
    const desktopEval = placement.evaluations.find((e) => e.nodeId === hostB.nodeId);
    const relayEval = placement.evaluations.find((e) => e.nodeId !== hostA.nodeId && e.nodeId !== hostB.nodeId)!;
    expect(desktopEval?.eligible).toBe(true);
    expect(relayEval.capabilityEligible).toBe(true);
    expect(relayEval.placementEligible).toBe(false);
    expect(placement.eligibleNodes.map((e) => e.nodeId)).toEqual([hostB.nodeId]);

    const reportA = await runtime(nodes, { required: true, trustedAttesterKeyIds: [keyA.keyId], validityMs: 300_000 }).executeRun(tenant.principal, {
      runId, hosts: [hostA], decider: browserDecider(), workflowInputs: { formUrl: FORM_URL },
    });
    expect(reportA.state).toBe('paused');
    expect(reportA.pausedAtStepId).toBe('approve');
    expect(reportA.steps.find((s) => s.stepId === 'collect')?.attestationsAttached).toBe(1);
    expect(browser.snapshot().find((e) => e.elementId === 'btn-submit')?.state).toBe('clicked');
    const historyA = await support.runs.getRunHistory(tenant.principal, runId);
    const bindingA = historyA.attestations.find((b) => b.stepId === 'collect')!;
    expect(bindingA.statement.nodeId).toBe(hostA.nodeId);
    const attestationA = hostA.attestations[0]!;
    const envelope = serializeAttestation(attestationA);
    const transferred = parseAttestation(envelope);
    expect(transferred.ok).toBe(true);
    if (!transferred.ok) throw new Error('envelope parse failed');

    const verifierReplay = new InMemoryReplayRegistry();
    const verification = verifyAttestation(transferred.attestation, {
      bindings: {
        workflowId: created.workflow.id, workflowVersionId: created.initialVersion.id,
        workflowVersionSemanticDigest: semanticDigest, deploymentId: installation.id,
        runId, attemptId: 1, stepId: 'collect',
      },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: verifierReplay },
      attesterKeyIds: [keyA.keyId],
    });
    expect(verification.ok).toBe(true);
    if (!verification.ok) throw new Error('verification failed');
    const fact = verification.fact;
    expect(fact.attests).toBe('statement_authenticity');
    expect(fact.neverAsserts).toEqual(['authorization', 'capability_possession', 'correct_behavior', 'observed_effect', 'sufficient_evidence']);

    const replay = verifyAttestation(transferred.attestation, {
      bindings: { runId },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: verifierReplay },
      attesterKeyIds: [keyA.keyId],
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.failure.code).toBe('ATTESTATION_REPLAYED');
    const epochStale = verifyAttestation(transferred.attestation, { bindings: { runId }, freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH + 1, replayRegistry: new InMemoryReplayRegistry() } });
    expect(epochStale.ok).toBe(false);
    if (!epochStale.ok) expect(epochStale.failure.code).toBe('ATTESTATION_EPOCH_STALE');
    const expired = verifyAttestation(transferred.attestation, { bindings: { runId }, freshness: { now: '2100-01-01T00:00:00.000Z', currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() } });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.failure.code).toBe('ATTESTATION_EXPIRED');

    const precondition: DependentStepPrecondition = {
      dependentStepId: 'record_ack',
      predecessorAttestationId: fact.attestationId,
      verifiedPredecessor: fact,
      causalParentDigests: [bindingA.executionDigest],
      runId,
      workflowVersionId: created.initialVersion.id,
      workflowVersionSemanticDigest: semanticDigest,
    };
    const reportB = await runtime(nodes, { required: true, trustedAttesterKeyIds: [keyA.keyId, keyB.keyId], validityMs: 3_600_000 }, ['record_ack']).resumeAfterHuman(tenant.principal, {
      runId, hosts: [hostB], humanOutcome: 'approved', humanUserId: operatorUserId, decider: ackDecider(), preconditions: [precondition],
    });
    expect(reportB.state).toBe('completed');
    expect(desktop.readFile(ACK_PATH)).toBe(ACK_CONTENT);

    const history: WorkflowRunHistory = await support.runs.getRunHistory(tenant.principal, runId);
    const bindingB = history.attestations.find((b) => b.stepId === 'record_ack')!;
    expect(bindingB.statement.runId).toBe(runId);
    expect(bindingB.statement.workflowVersionId).toBe(created.initialVersion.id);
    expect(bindingB.statement.nodeId).toBe(hostB.nodeId);
    expect(bindingB.statement.causalParents).toEqual([bindingA.executionDigest]);
    const causalVerification = verifyAttestation(hostB.attestations[0]!, {
      bindings: { runId, attemptId: 1, stepId: 'record_ack', causalParents: [bindingA.executionDigest] },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [keyB.keyId],
    });
    expect(causalVerification.ok).toBe(true);
    const wrongParent = verifyAttestation(hostB.attestations[0]!, {
      bindings: { runId, attemptId: 1, stepId: 'record_ack', causalParents: [sha256('wrong-parent')] },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [keyB.keyId],
    });
    expect(wrongParent.ok).toBe(false);
    if (!wrongParent.ok) {
      expect(wrongParent.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(wrongParent.failure.dimension).toBe('causalParents');
    }

    const evidenceIds = new Set(history.evidence.map((e) => e.id));
    for (const attestation of history.attestations) for (const reference of attestation.statement.evidenceReferences as readonly string[]) expect(evidenceIds.has(reference)).toBe(true);
    expect(history.run.state).toBe('completed');
    expect(history.attempts).toHaveLength(1);
    expect(history.steps.map((s) => [s.stepId, s.status])).toEqual([['collect', 'completed'], ['approve', 'completed'], ['record_ack', 'completed']]);
    expect(history.invocations.map((i) => i.capability)).toEqual(['browser.observe', 'browser.click', 'browser.observe', 'filesystem.read', 'filesystem.write', 'filesystem.read']);
    expect(history.invocations.every((i) => i.outcome === 'succeeded')).toBe(true);
    expect(new Set(history.attestations.map((b) => b.statement.nodeId))).toEqual(new Set([hostA.nodeId, hostB.nodeId]));

    const inbox = new InMemoryAttestationLedger();
    const firstDelivery = inbox.ingest(attestationA, support.clock.utc());
    const secondDelivery = inbox.ingest(attestationA, support.clock.utc());
    expect(firstDelivery.kind).toBe('accepted');
    expect(secondDelivery.kind).toBe('duplicate');
    expect(secondDelivery.deliveries).toBe(2);
    const duplicateAttach = await support.runs.attachAttestation(tenant.principal, { commandId: `cmd-agent-${runId}-att-${attestationA.attestationId}`, correlationId: `agent-${runId}` }, {
      runId, attemptNumber: 1, stepId: 'collect', attestation: attestationA, policy: { trustedAttesterKeyIds: [keyA.keyId] },
    });
    expect(duplicateAttach.executed).toBe(false);
    const finalRuns = await support.runs.listRunsInOrganization(tenant.principal, tenant.organizationId);
    expect(finalRuns).toHaveLength(1);
    expect(finalRuns[0]!.id).toBe(runId);
  });

  it('fails closed when the dependent step has no verified predecessor precondition', async () => {
    const tenant = await freshTenant('missing-precondition');
    const nodes = support.freshNodes();
    const keyA = generateAttesterKeyPair();
    const keyB = generateAttesterKeyPair();
    const browser = new ScriptedBrowserEnvironment([{ url: FORM_URL, elements: [{ elementId: 'btn-submit', kind: 'button', label: 'Submit', state: 'enabled' }] }]);
    const desktop = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const hostA = attachWebHost(keyA, browser, nodes);
    const hostB = attachDesktopHost(keyB, desktop, nodes);
    const created = await createWorkflow(tenant, 'ig6-missing-precondition', crossDeviceDocument());
    const run = await requestRun(tenant, created.workflow.id, created.initialVersion.id, 'ig6-missing-precondition');
    const reportA = await runtime(nodes, { required: true, trustedAttesterKeyIds: [keyA.keyId], validityMs: 300_000 }).executeRun(tenant.principal, { runId: run.id, hosts: [hostA], decider: browserDecider(), workflowInputs: { formUrl: FORM_URL } });
    expect(reportA.state).toBe('paused');
    const reportB = await runtime(nodes, { required: true, trustedAttesterKeyIds: [keyA.keyId, keyB.keyId], validityMs: 3_600_000 }, ['record_ack']).resumeAfterHuman(tenant.principal, {
      runId: run.id, hosts: [hostB], humanOutcome: 'approved', humanUserId: operatorUserId, decider: ackDecider(),
    });
    expect(reportB.state).toBe('failed');
    expect(reportB.failure?.code).toBe('AGENT_PRECONDITION_REJECTED');
    expect(desktop.readFile(ACK_PATH)).toBeNull();
    const history = await support.runs.getRunHistory(tenant.principal, run.id);
    expect(history.invocations.filter((i) => i.capability === 'filesystem.write')).toHaveLength(0);
  });

  it('keeps capability advertisement separate from authorization', async () => {
    const tenant = await freshTenant('authorization');
    const nodes = support.freshNodes();
    const registration = registerComputerHost({ nodes, keySeed: 'ig6-auth-node', platformClass: 'desktop', capabilities: FILE_CAPS });
    const desktop = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const host = new DesktopHostAdapter({ nodeId: registration.nodeId, sessionToken: registration.sessionToken, clock: () => support.clock.utc(), capabilities: FILE_CAPS, attestation: { supported: false, reason: 'no-attester-key' }, environment: desktop });
    const created = await createWorkflow(tenant, 'ig6-auth', localAckDocument());
    const run = await requestRun(tenant, created.workflow.id, created.initialVersion.id, 'ig6-auth');
    const agent = new ComputerAgentRuntime({
      recorder: support.runs, nodes, workflowRepository: support.repository, clock: () => support.clock.utc(), epoch: TRIGGER_TEST_EPOCH,
      policy: { maxActionsPerStep: 12, maxObservationAgeMs: 60_000, maxRecoveryCyclesPerStep: 4, safeAction: { grants: [{ capability: 'filesystem.read', scope: 'run' }] }, attestation: { required: false } }, replayRegistry: new InMemoryReplayRegistry(),
    });
    const report = await agent.executeRun(tenant.principal, { runId: run.id, hosts: [host], decider: ackDecider() });
    expect(report.failure?.code).toBe('AGENT_CAPABILITY_UNAUTHORIZED');
    expect(desktop.readFile(ACK_PATH)).toBeNull();
  });

  it('rejects insufficient attestation assurance explicitly', async () => {
    const tenant = await freshTenant('assurance');
    const nodes = support.freshNodes();
    const key = generateAttesterKeyPair();
    const browserless = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const registration = registerComputerHost({ nodes, keySeed: 'ig6-assurance-node', platformClass: 'desktop', capabilities: FILE_CAPS });
    const host = new CapturingHost(new DesktopHostAdapter({ nodeId: registration.nodeId, sessionToken: registration.sessionToken, clock: () => support.clock.utc(), capabilities: FILE_CAPS, attestation: { supported: true, attesterKeyId: key.keyId }, attesterKey: key, environment: browserless }));
    const created = await createWorkflow(tenant, 'ig6-assurance', localAckDocument());
    const run = await requestRun(tenant, created.workflow.id, created.initialVersion.id, 'ig6-assurance');
    const report = await runtime(nodes, { required: true, trustedAttesterKeyIds: [key.keyId], requiredAssurance: 'hardware_backed' }).executeRun(tenant.principal, { runId: run.id, hosts: [host], decider: ackDecider() });
    expect(report.failure?.code).toBe('AGENT_ATTESTATION_REJECTED');
    expect(report.failure?.detail).toContain('ATTESTATION_ASSURANCE_INSUFFICIENT');
  });
});

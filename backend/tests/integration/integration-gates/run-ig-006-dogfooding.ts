/**
 * IG-006 — standalone dogfooding RUN (real process, real product paths).
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/integration-gates/run-ig-006-dogfooding.ts
 *
 * Executes the frozen IG-006 dogfooding clause for real:
 *
 *   "Run one safe cross-device workflow using two real supported hosts.
 *    Execute a first step on host A, transfer the run, verify its
 *    attestation on host B, execute a dependent step, disconnect/reconnect
 *    or replay one message, and verify the resulting Run/evidence/proof
 *    graph remains correct and side-effect-safe."
 *
 * Real paths only: real PGlite (ALL 62 migrations incl. 0062) + the real
 * identity stack (API-key operator) + the REAL Fastify app with the REAL
 * V2-002 workflow-repository routes, the REAL V2-005 workflow-runs routes
 * and the REAL V2-009 workflow-deployments routes, every step driven over
 * HTTP via app.inject() + TWO hosts registered through the REAL V2-004
 * registration protocol driving the merged V2-008 ComputerAgentRuntime
 * over the real V2-005 run service as its recorder:
 *
 *   - HOST A (Node A, the web device kind): a WebBrowserHostAdapter over
 *     the merged ScriptedBrowserEnvironment carrying a REAL Ed25519
 *     attester key — the browser step's click is a REAL host action
 *     through the universal protocol.
 *   - HOST B (Node B, the desktop device kind): a DesktopHostAdapter over
 *     the merged RealFilesystemDesktopEnvironment (REAL node:fs/promises
 *     I/O rooted at a real sandbox directory) carrying a REAL Ed25519
 *     attester key — the dependent step's write is a REAL filesystem side
 *     effect, asserted by reading the real bytes back.
 *
 * The experiment (ONE safe cross-device workflow: browser step on Node A →
 * human handoff approval → device-local acknowledgment write on Node B):
 *
 *   1. ONE immutable version: authored (merged V2-003 builder), created +
 *      installed (pinned) through the real V2-002 routes, deployed + one
 *      file.changed subscription through the real V2-009 service (the
 *      deployment pins the SAME exact version tuple).
 *   2. THE TRIGGER + locality-aware placement: the real file.changed event
 *      (source = Node A, payload = the real intake-form file) delivered
 *      through the real ingest route → the run pins the version identity;
 *      the merged V2-004 matcher routes the browser step ONLY to Node A
 *      and the device-local dependent step ONLY to Node B (a cloud relay
 *      advertising the very same filesystem capabilities stays
 *      placement-INELIGIBLE — capability alone never routes); the
 *      duplicate event already converges here (still ONE run).
 *   3. EXECUTE the first step on HOST A: the merged runtime drives
 *      observe → grounded click → verify; the run PAUSES at the human
 *      handoff approval (the transfer moment); the browser submit button
 *      is REALLY clicked; ONE software_signed ExecutionAttestation is
 *      produced by Node A and durably attached through the real V2-005
 *      boundary.
 *   4. TRANSFER the run + the attestation: the run is DURABLE (PGlite);
 *      the attestation travels as the V2-014 CANONICAL ENVELOPE BYTES
 *      written to the transfer medium (a file), parsed on the receiving
 *      side, and verified by an INDEPENDENT VERIFIER PROCESS spawned by
 *      the runner — a runtime-generated script importing ONLY the merged
 *      execution-attestation public barrel, reading the raw bytes + an
 *      out-of-band verifier-context.json (trusted attester key ids +
 *      run-derived binding expectations + freshness) — real Ed25519
 *      verification with zero production context.
 *   5. VERIFY on HOST B (the independent V2-014 verifier domain — P3a;
 *      the PR #152 correction): Node B's own verifier context (its own
 *      single-use replay registry, its own trusted-attester list, the
 *      run-derived binding expectations) verifies the transferred
 *      attestation; the verified fact attests statement_authenticity ONLY
 *      and explicitly never asserts authorization / capability possession /
 *      correctness / observed effect / sufficiency; negatives ALL typed
 *      and side-effect free: an attester list that does not trust Node A's
 *      key refuses the verification (ATTESTATION_ATTESTER_UNEXPECTED, the
 *      acknowledgment file still absent), the re-presented handoff is a
 *      REPLAY (ATTESTATION_REPLAYED), an advanced protocol epoch is stale
 *      (ATTESTATION_EPOCH_STALE), an aged envelope is expired
 *      (ATTESTATION_EXPIRED). HONEST SCOPE: this verification result is NOT
 *      consumed by the dependent action's admission — the admission
 *      coupling gap is the P3b unsatisfied dependency machine-checked in
 *      section 9 (and pinned in the gate test).
 *   6. EXECUTE the dependent step on HOST B: resumeAfterHuman(approved) →
 *      the acknowledgment is REALLY written (real node:fs bytes asserted)
 *      EXACTLY ONCE; Node B produces its own attestation, verified +
 *      durably attached through the same boundary. NOTE (P3b): this
 *      execution is NOT structurally gated on the section-5 verification —
 *      the merged resume surface accepts no admission material (the gap
 *      is machine-checked in section 9). The causal legs are SPLIT (P5):
 *      P5a — the merged V2-014 verifier ENFORCES the causalParents
 *      dimension (a dependent statement carrying Node A's execution digest
 *      verifies under the causalParents expectation; the runtime's
 *      un-parented shape is refused typed on the causalParents dimension);
 *      P5b — UNSATISFIED DEPENDENCY: the runtime-produced dependent
 *      attestation carries causalParents: [] (the merged V2-008 production
 *      surface has no causal-parent input), so the actual dependent
 *      execution does not carry/enforce the causal predecessor binding.
 *   7. DISCONNECT/RECONNECT + REPLAY: the re-presented handoff (the
 *      reconnecting re-delivery of the admission message) is refused
 *      ATTESTATION_REPLAYED; the duplicate handoff delivery converges in
 *      the V2-014 ingestion ledger (accepted → duplicate, 2 deliveries,
 *      one identity); the duplicate event converges (zero new runs); the
 *      duplicate attach command converges exactly-once (executed=false);
 *      a re-attach under a NEW command id is rejected typed through the
 *      real route (HTTP 422 RUN_ATTESTATION_REJECTED, the DURABLE
 *      rejection row records ATTESTATION_REPLAYED); the duplicate host
 *      action converges in the host ledger (converged=true, NO second
 *      write — the real file bytes unchanged).
 *   8. THE RESULTING RUN/EVIDENCE/PROOF GRAPH: the full history read over
 *      the real route reconstructs the run pins, the single attempt, all
 *      three steps (web node → human approval → desktop node), the exact
 *      invocation sequence, the evidence class sequence, BOTH attestation
 *      bindings (same run/version/semantic/attempt identity, DIFFERENT
 *      node identities) whose evidenceReferences ALL resolve to real
 *      evidence records of this run, the exact protocol timeline (ZERO
 *      new events from every duplicate), the typed rejection row, and the
 *      exactly-once command log — with exactly ONE run, ONE write effect
 *      per host, and the immutable version byte-identical.
 *   9. THE P3b GAP PROBE (unsatisfied dependency, machine-checked on the
 *      same stack): a SECOND run of the SAME pinned immutable version —
 *      Node A executes its step (its own gates attach its attestation),
 *      then Node B resumes with NO verification leg in between and with a
 *      runtime policy that does NOT even trust Node A's attester key. The
 *      dependent action still executes (the probe acknowledgment file is
 *      really written): the dependent side effect occurs with ZERO
 *      admission decision derived from the independently verified Node-A
 *      attestation — the missing admission coupling, surfaced for the
 *      architect (frozen scope: no sibling modifications).
 *
 * GATE VERDICT: FAIL — 2 UNSATISFIED DEPENDENCIES (P3b admission coupling,
 * P5b runtime causal chain), per the architect's PR #152 REQUEST-CHANGES
 * directive. Exit codes: 3 = the fail-closed verdict (all machine-checkable
 * checks green and deterministic, both gaps machine-confirmed present);
 * 1 = an experiment check failed or determinism broke; 0 = unreachable
 * while the gaps are present (the gap checks fail loudly the moment an
 * owning module adds the real coupling, forcing this gate to be
 * revisited — the runner is self-invalidating by design).
 *
 * Determinism: fixed injected clocks (the shared trigger clock, epoch 7),
 * fixed node key seeds (node ids derive deterministically), fixed inputs.
 * The whole experiment runs TWICE on fresh stacks (fresh PGlite + fresh
 * identity stack + fresh sandbox per run); the transcripts are compared
 * after normalizing run-scoped bookkeeping (uuid-shaped ids, derived
 * dep_/sub_/evt_/dlv_/wfr_… ids, key-derived material — Ed25519 cannot be
 * seeded — sandbox suffixes, run labels), and the deterministic structured
 * facts (version digests, timeline, invocation/evidence sequences, typed
 * outcomes, node identities, the two gap probes) are compared
 * byte-for-byte.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import {
  createWorkflowIrBuilder,
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
  type WorkflowIrDocument,
  type WorkflowNode,
} from '../../../src/workflow-ir/index.js';
import {
  buildTriggerTestStack,
  versionContentOf,
  TRIGGER_TEST_EPOCH,
  type TriggerTestStack,
} from '../workflow-deployments/trigger-test-support.js';
import {
  ComputerAgentRuntime,
  WebBrowserHostAdapter,
  DesktopHostAdapter,
  RealFilesystemDesktopEnvironment,
  registerComputerHost,
  ScriptedBrowserEnvironment,
  formatUtcTimestamp,
  epochMsOf,
  type AgentDecider,
  type AttestingComputerHost,
  type ComputerAgentPolicy,
  type ComputerHostAdapter,
} from '../../../src/computer-agent/index.js';
import {
  generateAttesterKeyPair,
  serializeAttestation,
  parseAttestation,
  verifyAttestation,
  signExecutionAttestation,
  validateExecutionStatement,
  InMemoryReplayRegistry,
  InMemoryAttestationLedger,
  EXECUTION_STATEMENT_OBJECT_TYPE,
  EXECUTION_STATEMENT_SCHEMA_VERSION,
  type AttesterKeyPair,
  type ExecutionAttestation,
  type ExecutionStatement,
} from '../../../src/execution-attestation/index.js';

const API_KEY = 'ig-006-dogfooding-api-key';
const OPERATOR_EXTERNAL_ID = 'ig-006-dogfooding-operator';
const FORM_URL = 'https://dogfooding.example/intake';
const ACK_PATH = 'reports/ack.md';
const ACK_CONTENT = 'ACK: intake form submitted and attested across devices';
/** The P3b gap-probe run's DISTINCT side effect (never conflated with the main run's). */
const PROBE_ACK_PATH = 'reports/probe-ack.md';
const PROBE_ACK_CONTENT = 'PROBE ACK: dependent action executed with NO admission decision (the P3b gap, machine-checked)';
const INTAKE_FORM_PATH = 'inbox/intake-form.txt';
const INTAKE_FORM_CONTENT = [
  'INTAKE FORM — cross-device execution attestation dogfooding',
  'field: requester = ig-006-dogfooding-operator',
  'field: subject = cross-device handoff acceptance',
].join('\n');
/** Fixed node key seeds (node ids derive deterministically from these). */
const HOST_A_KEY_SEED = 'ig-006-dogfooding-node-a-web';
const HOST_B_KEY_SEED = 'ig-006-dogfooding-node-b-desktop';
const CLOUD_RELAY_KEY_SEED = 'ig-006-dogfooding-cloud-relay';
const CLOUD_POLICY = { placement: { required: 'cloud_allowed' as const }, privacy: { localOnly: false } };
/** The runner is spawned from backend/ (the family precedent). */
const BACKEND_DIR = process.cwd();
const ATTESTATION_BARREL_URL = pathToFileURL(
  join(BACKEND_DIR, 'src', 'execution-attestation', 'index.js'),
).href;

// ============================================================================
// The transcript harness (check/section/norm — the family precedent)
// ============================================================================

const transcript: string[] = [];
let failures = 0;

function section(title: string): void {
  transcript.push(`\n--- ${title} ---`);
}

function norm(value: string): string {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-4)}` : value;
}

function check(id: string, ok: boolean, message: string): void {
  if (!ok) failures += 1;
  transcript.push(`[${ok ? 'PASS' : 'FAIL'}] ${id} :: ${message}`);
}

function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ============================================================================
// The expected protocol shape (pinned by the gate test; identical fixture)
// ============================================================================

const EXPECTED_TIMELINE: readonly string[] = [
  'workflow.run.requested',
  'workflow.run.started',
  'workflow.step.started',
  'capability.invocation.requested',
  'capability.invocation.completed',
  'observation.recorded',
  'capability.invocation.requested',
  'capability.invocation.completed',
  'capability.invocation.requested',
  'capability.invocation.completed',
  'observation.recorded',
  'execution.attestation.verified',
  'verification.completed',
  'workflow.step.completed',
  'workflow.step.started',
  'workflow.run.paused',
  'workflow.run.resumed',
  'workflow.step.completed',
  'workflow.step.started',
  'capability.invocation.requested',
  'capability.invocation.completed',
  'observation.recorded',
  'capability.invocation.requested',
  'capability.invocation.completed',
  'capability.invocation.requested',
  'capability.invocation.completed',
  'observation.recorded',
  'execution.attestation.verified',
  'verification.completed',
  'workflow.step.completed',
  'workflow.run.completed',
];

const EXPECTED_INVOCATIONS: readonly string[] = [
  'browser.observe',
  'browser.click',
  'browser.observe',
  'filesystem.read',
  'filesystem.write',
  'filesystem.read',
];

const EXPECTED_EVIDENCE_CLASSES: readonly string[] = [
  'claim',
  'claim',
  'human_confirmation',
  'intent',
  'intent',
  'intent',
  'intent',
  'intent',
  'intent',
  'observation',
  'observation',
  'observation',
  'observation',
  'verification',
  'verification',
];

/** The deterministic structured facts compared byte-for-byte across runs. */
interface RunFacts {
  readonly versionContentDigest: string;
  readonly versionSemanticDigest: string;
  readonly ackFileBytes: string;
  readonly intakeFormDigest: string;
  readonly runState: string;
  readonly stepStatuses: readonly (readonly [string, string])[];
  readonly attemptCount: number;
  readonly timeline: readonly string[];
  readonly invocations: readonly string[];
  readonly evidenceClasses: readonly string[];
  readonly humanEvidenceProducer: readonly [string, string];
  readonly attestationBindings: readonly {
    readonly stepId: string;
    readonly assurance: string;
    readonly nodeId: string;
    readonly statement: {
      readonly executionClass: string;
      readonly capability: string;
      readonly attemptId: number;
      readonly epoch: number;
      readonly outcome: string;
      readonly causalParents: readonly string[];
      readonly evidenceReferenceCount: number;
      readonly evidenceReferencesResolve: boolean;
    };
  }[];
  readonly distinctExecutionDigests: number;
  readonly admission: { readonly ok: boolean; readonly attests: string; readonly neverAsserts: readonly string[] };
  readonly independentVerifierProcess: { readonly ok: boolean; readonly attests: string; readonly neverAsserts: readonly string[] };
  readonly negatives: {
    readonly untrustedAttester: string;
    readonly replayedHandoff: string;
    readonly epochStale: string;
    readonly expired: string;
  };
  readonly causalParentBinding: { readonly parentedVerifies: boolean; readonly unparentedRefused: string; readonly unparentedDimension: string };
  readonly p3bAdmissionGapProbe: {
    readonly probeRunCompleted: boolean;
    readonly probeAckWritten: boolean;
    /** false by probe design: Node B's runtime policy excludes Node A's key. */
    readonly nodeBPolicyTrustsNodeA: boolean;
  };
  readonly p5bCausalGap: { readonly runtimeDependentCausalParentCount: number };
  readonly replayConvergence: {
    readonly ledgerFirstDelivery: string;
    readonly ledgerSecondDelivery: string;
    readonly duplicateEventCreated: boolean;
    readonly runsAfterDuplicates: number;
    readonly duplicateAttachExecuted: boolean;
    readonly routeReplayStatus: number;
    readonly routeReplayCode: string;
    readonly durableRejectionCode: string;
    readonly durableRejectionCount: number;
    readonly duplicateHostActionConverged: boolean;
    readonly writeInvocationCount: number;
  };
}

// ============================================================================
// The workflow (authored through the merged V2-003 builder) + the deciders
// ============================================================================

function authorCrossDeviceDocument(
  ackPath: string = ACK_PATH,
  ackContent: string = ACK_CONTENT,
): WorkflowIrDocument {
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
    spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve the cross-device handoff before the device-local acknowledgment.' } },
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
      { name: 'ackPath', type: { kind: 'string' }, binding: { kind: 'literal', value: ackPath } },
      { name: 'ackContent', type: { kind: 'string' }, binding: { kind: 'literal', value: ackContent } },
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
    .addEdge({ from: 'approve', to: 'record_ack', on: { outcome: 'rejected' } })
    .build();
}

/**
 * The P3b gap-probe document: IDENTICAL shape with DISTINCT output-path
 * literals — the probe run's side effect is a separate real file, so the
 * gap proof (the dependent action executing without admission) can never
 * be conflated with the main run's acknowledgment.
 */
function authorGapProbeDocument(): WorkflowIrDocument {
  return authorCrossDeviceDocument(PROBE_ACK_PATH, PROBE_ACK_CONTENT);
}

/** The Node A decider: observe the page → grounded click → verify. */
function createBrowserSubmitDecider(): AgentDecider {
  return (ctx) => {
    const formUrl = typeof ctx.inputs.formUrl === 'string' ? ctx.inputs.formUrl : FORM_URL;
    if (ctx.observation === null) {
      return { decision: 'observe', capability: 'browser.observe', subject: formUrl };
    }
    const clicked = ctx.history.some((record) => record.capability === 'browser.click' && record.ok);
    if (!clicked) {
      const target = ctx.observation.elements.find((element) => element.elementId === 'btn-submit');
      return {
        decision: 'act',
        capability: 'browser.click',
        grounding: target
          ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest }
          : null,
        parameters: {},
      };
    }
    return {
      decision: 'complete',
      verify: { capability: 'browser.observe', subject: formUrl, expect: { elementId: 'btn-submit', state: 'clicked' } },
      outputs: { submitted: true },
    };
  };
}

/** The Node B decider: observe the target → grounded write → verify. */
function createAckWriteDecider(): AgentDecider {
  return (ctx) => {
    const path = typeof ctx.inputs.ackPath === 'string' ? ctx.inputs.ackPath : ACK_PATH;
    const content = typeof ctx.inputs.ackContent === 'string' ? ctx.inputs.ackContent : ACK_CONTENT;
    if (ctx.observation === null) {
      return { decision: 'observe', capability: 'filesystem.read', subject: path };
    }
    const wrote = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
    if (!wrote) {
      const target = ctx.observation.elements.find((element) => element.elementId === path);
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: target
          ? { observationId: ctx.observation.observationId, targetElementId: target.elementId, targetDigest: target.digest }
          : null,
        parameters: { path, content },
      };
    }
    return {
      decision: 'complete',
      verify: { capability: 'filesystem.read', subject: path, expect: { elementId: path, state: content } },
      outputs: { written: true },
    };
  };
}

// ============================================================================
// The two real hosts + the runtime composition (merged barrels only)
// ============================================================================

/**
 * A delegating attesting host that CAPTURES every attestation it signs (the
 * exact envelope the runtime produced — the cross-device transfer needs the
 * real signed object, never a reconstruction).
 */
class CapturingHost implements AttestingComputerHost {
  readonly nodeId: string;
  readonly sessionToken: string;
  readonly platformClass: AttestingComputerHost['platformClass'];
  readonly capabilities: AttestingComputerHost['capabilities'];
  readonly attestationSupport: { readonly supported: true; readonly attesterKeyId: string };
  private readonly captured: ExecutionAttestation[] = [];
  private readonly inner: AttestingComputerHost;

  constructor(inner: ComputerHostAdapter) {
    if (!inner.attestationSupport.supported || typeof (inner as AttestingComputerHost).signStatement !== 'function') {
      throw new Error('CapturingHost requires a host with real attester key material');
    }
    this.inner = inner as AttestingComputerHost;
    this.nodeId = inner.nodeId;
    this.sessionToken = inner.sessionToken;
    this.platformClass = inner.platformClass;
    this.capabilities = inner.capabilities;
    this.attestationSupport = inner.attestationSupport;
  }

  /** Every attestation this host signed for the runtime, in order. */
  get attestations(): readonly ExecutionAttestation[] {
    return [...this.captured];
  }

  invoke(invocationId: string, request: Parameters<ComputerHostAdapter['invoke']>[1]): ReturnType<ComputerHostAdapter['invoke']> {
    return this.inner.invoke(invocationId, request);
  }

  nextNonce(): string {
    return this.inner.nextNonce();
  }

  signStatement(statement: ExecutionStatement, issuedAt: string): ExecutionAttestation {
    const attestation = this.inner.signStatement(statement, issuedAt);
    this.captured.push(attestation);
    return attestation;
  }
}

const BROWSER_CAPS = [
  { name: 'browser.observe', version: 1, availability: 'available' as const },
  { name: 'browser.click', version: 1, availability: 'available' as const },
];
const FILESYSTEM_CAPS = [
  { name: 'filesystem.read', version: 1, availability: 'available' as const },
  { name: 'filesystem.write', version: 1, availability: 'available' as const },
];

/** Attach the web host (Node A) with a REAL Ed25519 attester key. */
function attachWebHost(key: AttesterKeyPair, environment: ScriptedBrowserEnvironment, nodes: TriggerTestStack['nodes']): CapturingHost {
  const registration = registerComputerHost({
    nodes,
    keySeed: HOST_A_KEY_SEED,
    platformClass: 'web',
    capabilities: BROWSER_CAPS,
  });
  return new CapturingHost(new WebBrowserHostAdapter({
    nodeId: registration.nodeId,
    sessionToken: registration.sessionToken,
    clock: () => supportClock().utc(),
    capabilities: BROWSER_CAPS,
    attestation: { supported: true, attesterKeyId: key.keyId },
    attesterKey: key,
    environment,
  }));
}

/** Attach the desktop host (Node B) with a REAL Ed25519 attester key. */
function attachDesktopHost(
  key: AttesterKeyPair,
  environment: RealFilesystemDesktopEnvironment,
  nodes: TriggerTestStack['nodes'],
): CapturingHost {
  const registration = registerComputerHost({
    nodes,
    keySeed: HOST_B_KEY_SEED,
    platformClass: 'desktop',
    capabilities: FILESYSTEM_CAPS,
  });
  return new CapturingHost(new DesktopHostAdapter({
    nodeId: registration.nodeId,
    sessionToken: registration.sessionToken,
    clock: () => supportClock().utc(),
    capabilities: FILESYSTEM_CAPS,
    attestation: { supported: true, attesterKeyId: key.keyId },
    attesterKey: key,
    environment,
  }));
}

// The shared clock of the CURRENT experiment (scoped per run; see main()).
let activeSupport: TriggerTestStack | null = null;
function supportClock(): TriggerTestStack['clock'] {
  if (activeSupport === null) {
    throw new Error('no active experiment support stack');
  }
  return activeSupport.clock;
}

/** One node's runtime over the REAL stack (each node: its OWN replay registry). */
function nodeRuntime(nodes: TriggerTestStack['nodes'], attestation: ComputerAgentPolicy['attestation']): ComputerAgentRuntime {
  return new ComputerAgentRuntime({
    recorder: activeSupport!.runs,
    nodes,
    workflowRepository: activeSupport!.repository,
    clock: () => supportClock().utc(),
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
    },
    replayRegistry: new InMemoryReplayRegistry(),
  });
}

// ============================================================================
// The independent verifier PROCESS (runtime-generated; imports ONLY the
// merged execution-attestation public barrel — zero production context)
// ============================================================================

/**
 * The source of the verifier process, materialized into the run sandbox.
 * It receives the RAW canonical envelope bytes + an out-of-band
 * verifier-context.json (trusted attester key ids, run-derived binding
 * expectations, freshness) and verifies with the merged public verifier
 * and its OWN fresh single-use replay registry.
 */
function independentVerifierSource(): string {
  return [
    '// IG-006 runtime-generated independent verifier (not a repository file).',
    '// Imports ONLY the merged execution-attestation public barrel.',
    "import { readFileSync } from 'node:fs';",
    'async function verify(): Promise<void> {',
    `  const barrel = await import(${JSON.stringify(ATTESTATION_BARREL_URL)});`,
    '  const envelopeFile = process.argv[2];',
    '  const contextFile = process.argv[3];',
    "  const bytes = readFileSync(envelopeFile, 'utf8');",
    "  const context = JSON.parse(readFileSync(contextFile, 'utf8'));",
    '  const parsed = barrel.parseAttestation(bytes);',
    '  if (!parsed.ok) {',
    "    console.log(JSON.stringify({ parsed: false, code: parsed.failure.code }));",
    '    return;',
    '  }',
    '  const verification = barrel.verifyAttestation(parsed.attestation, {',
    '    bindings: context.bindings,',
    '    freshness: {',
    '      now: context.freshness.now,',
    '      currentEpoch: context.freshness.currentEpoch,',
    '      replayRegistry: new barrel.InMemoryReplayRegistry(),',
    '    },',
    '    attesterKeyIds: context.attesterKeyIds,',
    '  });',
    '  console.log(JSON.stringify(',
    '    verification.ok',
    '      ? { parsed: true, ok: true, attests: verification.fact.attests, neverAsserts: verification.fact.neverAsserts, verifiedAt: verification.fact.verifiedAt }',
    '      : { parsed: true, ok: false, code: verification.failure.code, detail: verification.failure.detail },',
    '  ));',
    '}',
    "verify().catch((error) => { console.error(String(error)); process.exit(1); });",
  ].join('\n');
}

// ============================================================================
// One dogfooding RUN (the experiment; returns transcript + structured facts)
// ============================================================================

async function runExperiment(runLabel: string): Promise<{ text: string; facts: RunFacts }> {
  const support: TriggerTestStack = await buildTriggerTestStack({
    WFOS_IG_006_DOGFOODING_KEY: API_KEY,
  });
  activeSupport = support;
  transcript.length = 0;
  let app: FastifyInstance;
  try {
    // --- the operator tenant ----------------------------------------------
    const operator = await support.stack.userRepository.upsertByExternalId({
      externalId: OPERATOR_EXTERNAL_ID,
      displayName: 'IG-006 Dogfooding Operator',
    });
    const org = await support.stack.organizationRepository.create({ name: `IG-006 Dogfooding Org ${runLabel}` });
    await support.stack.membershipRepository.assign({
      userId: operator.id,
      organizationId: org.id,
      roleId: 'owner',
    });
    const orgId = org.id;
    const principal = { userId: operator.id };

    const provisioner = new ApiKeyCredentialProvisioner(support.stack.db.client);
    await provisioner.provision({
      keyId: 'ig-006-dogfooding-key',
      secretRef: 'WFOS_IG_006_DOGFOODING_KEY',
      externalId: OPERATOR_EXTERNAL_ID,
      label: 'IG-006 Dogfooding Operator',
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

    const inject = async (
      method: 'GET' | 'POST',
      url: string,
      payload?: unknown,
    ): Promise<{ status: number; body: Record<string, unknown>; raw: string }> => {
      const response = await app.inject({
        method,
        url,
        headers:
          payload === undefined
            ? { authorization: `Bearer ${API_KEY}` }
            : { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        payload: payload as Record<string, unknown> | undefined,
      });
      return {
        status: response.statusCode,
        body: (response.json() ?? {}) as Record<string, unknown>,
        raw: response.body,
      };
    };

    // --- the two REAL supported hosts (real sandbox filesystem on Node B) --
    const sandboxDir = mkdtempSync(join(tmpdir(), 'ig-006-dogfood-'));
    mkdirSync(join(sandboxDir, 'inbox'), { recursive: true });
    mkdirSync(join(sandboxDir, 'reports'), { recursive: true });
    writeFileSync(join(sandboxDir, INTAKE_FORM_PATH), INTAKE_FORM_CONTENT, 'utf8');
    const keyA = generateAttesterKeyPair();
    const keyB = generateAttesterKeyPair();
    const browserEnvironment = new ScriptedBrowserEnvironment([{
      url: FORM_URL,
      elements: [
        { elementId: 'btn-submit', kind: 'button', label: 'Submit', state: 'enabled' },
        { elementId: 'input-notes', kind: 'input', label: 'Notes', state: '' },
      ],
    }]);
    const desktopEnvironment = new RealFilesystemDesktopEnvironment({ root: sandboxDir });
    const hostA = attachWebHost(keyA, browserEnvironment, support.nodes);
    const hostB = attachDesktopHost(keyB, desktopEnvironment, support.nodes);
    const ackFile = join(sandboxDir, ACK_PATH);

    section(`${runLabel} — 0. ONE immutable version: authored, installed (pinned), deployed`);
    const createRes = await inject('POST', `/organizations/${orgId}/workflow-repository/workflows`, {
      slug: 'ig6-cross-device-intake-ack',
      name: 'Cross-Device Intake Acknowledgment',
      description: 'Browser step on the web device, human handoff approval, device-local acknowledgment write',
      visibility: 'private',
      content: versionContentOf(authorCrossDeviceDocument()),
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    });
    const created = createRes.body as unknown as {
      workflow: { id: string };
      initialVersion: { id: string; versionNumber: number; contentDigest: string };
    };
    const workflowId = created.workflow.id;
    const versionId = created.initialVersion.id;
    check(
      '0.version-created',
      createRes.status === 201 && created.initialVersion.versionNumber === 1,
      `the cross-device gate workflow created through the real V2-002 route (version 1, content digest ${norm(created.initialVersion.contentDigest)})`,
    );

    const installRes = await inject('POST', `/organizations/${orgId}/workflow-repository/installations`, {
      workflowId,
      versionId,
    });
    const installation = (installRes.body as unknown as { installation: { id: string; versionId: string; status: string } }).installation;
    check(
      '0.version-installed',
      installRes.status === 201 && installation.versionId === versionId && installation.status === 'enabled',
      'version 1 INSTALLED (pinned) through the real installations route',
    );

    const readRes = await inject('GET', `/workflow-repository/workflows/${workflowId}/versions/${versionId}`);
    const versionBodyBefore = readRes.raw;
    const parsed = parseWorkflowIrDocument(
      JSON.stringify((readRes.body as unknown as { version: { content: Record<string, unknown> } }).version.content),
    );
    const baselineDocument = parsed.ok ? parsed.document : null;
    const semanticDigestOfBaseline = baselineDocument !== null ? computeWorkflowVersionSemanticDigest(baselineDocument).digest : null;
    check(
      '0.version-readable',
      readRes.status === 200 && baselineDocument !== null && semanticDigestOfBaseline !== null,
      `the installed version read back over HTTP; V2-003 semantic digest ${semanticDigestOfBaseline !== null ? norm(semanticDigestOfBaseline) : '—'}`,
    );
    if (semanticDigestOfBaseline === null) {
      throw new Error('the installed version did not parse (unreachable in a passing run)');
    }
    const semanticDigest = semanticDigestOfBaseline;

    const { deployment } = await support.deployments.createDeployment(principal, {
      organizationId: orgId,
      workflowId,
      versionId,
      installationId: installation.id,
      name: 'ig6-cross-device-deployment',
      placement: CLOUD_POLICY,
    });
    const { subscription: eventSubscription } = await support.deployments.createSubscription(principal, {
      deploymentId: deployment.id,
      kind: 'event',
      eventPattern: { eventType: 'file.changed' },
    });
    check(
      '0.deployed',
      deployment.workflowId === workflowId && deployment.versionId === versionId && deployment.installationId === installation.id,
      'the deployment pins the SAME installed version tuple (V2-009 over the same immutable pin); one file.changed subscription',
    );

    section(`${runLabel} — 1. THE TRIGGER + locality-aware placement (the run pins the version)`);
    const eventPayload = {
      source: hostA.nodeId,
      eventId: 'ig6-intake-form-change-0001',
      eventType: 'file.changed',
      payload: { path: INTAKE_FORM_PATH },
    };
    const first = await inject('POST', `/organizations/${orgId}/workflow-deployments/events`, eventPayload);
    const firstEvent = (first.body as unknown as { event: { id: string; payloadCommitment: string } }).event;
    const firstDeliveries = (first.body as unknown as { deliveries: { state: string; runId: string | null }[] }).deliveries;
    check(
      '1.event-delivered',
      first.status === 201 && first.body.created === true && firstDeliveries.length === 1 && firstDeliveries[0]!.state === 'delivered',
      `the real file.changed event (source = Node A, payload = the real intake-form file) ingested over HTTP: one delivery, state delivered`,
    );
    const runId = firstDeliveries[0]!.runId!;

    const run = await support.runs.getRun(principal, runId);
    check(
      '1.run-pins-version',
      run.workflowId === workflowId &&
        run.versionId === versionId &&
        run.versionContentDigest === created.initialVersion.contentDigest &&
        run.versionSemanticDigest === semanticDigest &&
        run.installationId === installation.id &&
        run.trigger.type === 'file_event' &&
        run.trigger.id === `evt:${firstEvent.id}:${eventSubscription.id}` &&
        JSON.stringify(run.inputCommitments) === JSON.stringify([firstEvent.payloadCommitment]),
      `the triggered run pins the EXACT version identity (workflow + version + content/semantic digests + installation) with the event/run correlation (trigger id embeds the inbox event identity; the run's input commitment IS the event's payload commitment)`,
    );

    // Locality-aware placement: the merged V2-004 matcher routes each step's
    // requirement set. A cloud relay advertising the very same filesystem
    // capabilities stays placement-INELIGIBLE for the device-local step.
    registerComputerHost({
      nodes: support.nodes,
      keySeed: CLOUD_RELAY_KEY_SEED,
      platformClass: 'cloud',
      capabilities: FILESYSTEM_CAPS,
    });
    const collectMatch = support.nodes.matchNodes({
      id: 'step:collect',
      capabilities: [{ name: 'browser.observe' }, { name: 'browser.click' }],
      placement: { required: 'cloud_allowed' },
      minTrustTier: 'provisional',
    });
    const dependentMatch = support.nodes.matchNodes({
      id: 'step:record_ack',
      capabilities: [{ name: 'filesystem.read' }, { name: 'filesystem.write' }],
      placement: { required: 'device_local' },
      minTrustTier: 'provisional',
    });
    // the cloud relay advertises the VERY SAME filesystem capabilities — it
    // is capability-ELIGIBLE for the dependent step yet placement-INELIGIBLE
    // (the locality dimension discriminates; capability alone never routes).
    const relayEvaluation = dependentMatch.evaluations.find(
      (evaluation) => evaluation.nodeId !== hostA.nodeId && evaluation.nodeId !== hostB.nodeId,
    );
    check(
      '1.placement-routes-two-devices',
      collectMatch.eligibleNodes.map((evaluation) => evaluation.nodeId).join(',') === hostA.nodeId &&
        dependentMatch.eligibleNodes.map((evaluation) => evaluation.nodeId).join(',') === hostB.nodeId &&
        relayEvaluation !== undefined &&
        relayEvaluation.capabilityEligible === true &&
        relayEvaluation.placementEligible === false &&
        relayEvaluation.eligible === false,
      `locality-aware placement: the browser step routes ONLY to Node A (web, ${norm(hostA.nodeId)}), the device-local dependent step ONLY to Node B (desktop, ${norm(hostB.nodeId)}); the cloud relay advertising the SAME filesystem capabilities is capability-eligible yet placement-INELIGIBLE (capability alone never routes)`,
    );

    // The duplicate event converges idempotently (still exactly ONE run).
    const duplicateEvent = await inject('POST', `/organizations/${orgId}/workflow-deployments/events`, eventPayload);
    const runsAfterDuplicate = await support.runs.listRunsInOrganization(principal, orgId);
    check(
      '1.duplicate-event-converged',
      duplicateEvent.status === 200 &&
        duplicateEvent.body.created === false &&
        (duplicateEvent.body as unknown as { deliveries: unknown[] }).deliveries.length === 0 &&
        runsAfterDuplicate.length === 1,
      'duplicate event CONVERGED idempotently (HTTP 200, created=false, zero new deliveries); still exactly ONE run',
    );

    section(`${runLabel} — 2. EXECUTE the first step on HOST A (Node A, the web device)`);
    const runtimeA = nodeRuntime(support.nodes, {
      required: true,
      trustedAttesterKeyIds: [keyA.keyId],
      validityMs: 300_000,
    });
    const reportA = await runtimeA.executeRun(principal, {
      runId,
      hosts: [hostA as ComputerHostAdapter],
      decider: createBrowserSubmitDecider(),
      workflowInputs: { formUrl: FORM_URL },
    });
    const submitButton = browserEnvironment.snapshot().find((element) => element.elementId === 'btn-submit');
    check(
      '2.step-a-executed',
      reportA.state === 'paused' &&
        reportA.pausedAtStepId === 'approve' &&
        reportA.steps.length === 2 &&
        reportA.steps[0]!.stepId === 'collect' &&
        reportA.steps[0]!.outcome === 'completed' &&
        reportA.steps[0]!.nodeId === hostA.nodeId &&
        reportA.steps[0]!.attestationsAttached === 1 &&
        reportA.steps[0]!.attestationsRejected === 0 &&
        submitButton?.state === 'clicked',
      `the browser step COMPLETED on Node A through the merged runtime (observe → grounded click → verify) and the run PAUSED at the human handoff approval (the transfer moment); the submit button is REALLY clicked on the web host`,
    );

    const historyAfterA = await support.runs.getRunHistory(principal, runId);
    const bindingA = historyAfterA.attestations[0] ?? null;
    check(
      '2.attestation-a-produced',
      historyAfterA.run.state === 'paused' &&
        historyAfterA.attestations.length === 1 &&
        bindingA !== null &&
        bindingA.stepId === 'collect' &&
        bindingA.attesterKeyId === keyA.keyId &&
        bindingA.assurance === 'software_signed' &&
        bindingA.statement.nodeId === hostA.nodeId &&
        bindingA.statement.runId === runId &&
        bindingA.statement.workflowId === workflowId &&
        bindingA.statement.workflowVersionId === versionId &&
        bindingA.statement.workflowVersionSemanticDigest === semanticDigest &&
        bindingA.statement.attemptId === 1,
      `Node A produced ONE software_signed ExecutionAttestation, durably attached through the real V2-005 boundary (statement bound to the run/version/semantic-digest/attempt/step/node)`,
    );
    const attestationA = hostA.attestations[0]!;

    section(`${runLabel} — 3. TRANSFER the run + the attestation (canonical bytes on the transfer medium)`);
    // The run itself is DURABLE (PGlite) — Node B will resume THE SAME run.
    // The attestation travels as the V2-014 canonical envelope bytes.
    const transferDir = join(sandboxDir, 'transfer');
    mkdirSync(transferDir, { recursive: true });
    const envelopeFile = join(transferDir, 'attestation-node-a.json');
    const envelopeBytes = serializeAttestation(attestationA);
    writeFileSync(envelopeFile, envelopeBytes, 'utf8');
    const transferred = parseAttestation(envelopeBytes);
    check(
      '3.envelope-transferred',
      transferred.ok && transferred.attestation.attestationId === attestationA.attestationId,
      `Node A's attestation serialized to the V2-014 canonical envelope bytes (${envelopeBytes.length} chars) on the transfer medium and parsed back with the SAME identity + statement`,
    );

    // The out-of-band verifier context: trusted attester key ids +
    // run-derived binding expectations + freshness (NOT inside the envelope).
    const verifierContext = {
      bindings: {
        workflowId,
        workflowVersionId: versionId,
        workflowVersionSemanticDigest: semanticDigest,
        deploymentId: installation.id,
        runId,
        attemptId: 1,
        stepId: 'collect',
      },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH },
      attesterKeyIds: [keyA.keyId, keyB.keyId],
    };
    const contextFile = join(transferDir, 'verifier-context.json');
    writeFileSync(contextFile, JSON.stringify(verifierContext, null, 2), 'utf8');
    const verifierScript = join(transferDir, 'independent-verifier.mts');
    writeFileSync(verifierScript, independentVerifierSource(), 'utf8');
    const verifier = spawnSync('bunx', ['tsx', verifierScript, envelopeFile, contextFile], {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
    });
    let independent: { parsed: boolean; ok: boolean; attests?: string; neverAsserts?: string[]; verifiedAt?: string; code?: string } | null = null;
    try {
      independent = JSON.parse((verifier.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? 'null');
    } catch {
      independent = null;
    }
    check(
      '3.independent-verifier-process',
      verifier.status === 0 && independent !== null && independent.parsed === true && independent.ok === true && independent.attests === 'statement_authenticity',
      `the INDEPENDENT VERIFIER PROCESS (imports ONLY the merged public barrel; raw envelope bytes + out-of-band verifier-context.json) verified the transferred attestation with real Ed25519: ok, attests ${JSON.stringify(independent?.attests ?? null)}, neverAsserts ${JSON.stringify(independent?.neverAsserts ?? null)}`,
    );

    section(`${runLabel} — 4. VERIFY on HOST B (the independent V2-014 verifier domain — P3a; NOT consumed by the dependent action's admission)`);
    // Node B's own verifier: its OWN single-use replay registry, its own
    // trusted-attester list, the run-derived binding expectations.
    // HONEST SCOPE (the PR #152 correction): verifier-domain proof only —
    // the result below is NOT consumed by the resumeAfterHuman path (the
    // admission coupling gap is the P3b unsatisfied dependency, machine-
    // checked in section 9 below and pinned in the gate test).
    const nodeBReplayRegistry = new InMemoryReplayRegistry();
    const admission = verifyAttestation(transferred.ok ? transferred.attestation : attestationA, {
      bindings: {
        workflowId,
        workflowVersionId: versionId,
        workflowVersionSemanticDigest: semanticDigest,
        deploymentId: installation.id,
        runId,
        attemptId: 1,
        stepId: 'collect',
      },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: nodeBReplayRegistry },
      attesterKeyIds: [keyA.keyId, keyB.keyId],
    });
    const admissionFact = admission.ok ? admission.fact : null;
    check(
      '4.independent-verification-p3a',
      admission.ok && admissionFact !== null && admissionFact.attests === 'statement_authenticity' && admissionFact.attesterKeyId === keyA.keyId && admissionFact.verifiedAt === support.clock.utc(),
      `Node B's verifier context (fresh single-use replay registry, Node B's trusted-attester list, run-derived binding expectations) verifies the transferred attestation (P3a, the V2-014 verifier domain): the verified fact attests statement_authenticity only — NOTE: this verification result is NOT consumed by the dependent action's admission (the admission coupling is the P3b unsatisfied dependency, machine-checked in section 9)`,
    );
    check(
      '4.signature-never-authorizes',
      admissionFact !== null &&
        JSON.stringify(admissionFact.neverAsserts) ===
          JSON.stringify(['authorization', 'capability_possession', 'correct_behavior', 'observed_effect', 'sufficient_evidence']) &&
        admissionFact.nonAuthorityNote.includes('never authorization'),
      `the verified fact EXPLICITLY never asserts authorization / capability possession / correct behavior / observed effect / sufficient evidence (a valid signature is never a trust grant)`,
    );

    // Negative: a Node B verifier that does NOT trust Node A's key refuses
    // admission typed — Node B's side effects remain ZERO.
    const untrusted = verifyAttestation(transferred.ok ? transferred.attestation : attestationA, {
      bindings: { runId },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [keyB.keyId],
    });
    check(
      '4.untrusted-attester-refused',
      untrusted.ok === false && (untrusted.ok ? null : untrusted.failure.code) === 'ATTESTATION_ATTESTER_UNEXPECTED' && !existsSync(ackFile),
      `a verifier that does not trust Node A's key refuses the verification TYPED (ATTESTATION_ATTESTER_UNEXPECTED; the dependent step has not executed yet — but NOTE: this typed refusal is not consumed downstream either; the admission coupling gap is section 9)`,
    );

    // Freshness/replay negatives (all typed, all side-effect free).
    const retry = verifyAttestation(transferred.ok ? transferred.attestation : attestationA, {
      bindings: { runId },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: nodeBReplayRegistry },
      attesterKeyIds: [keyA.keyId, keyB.keyId],
    });
    check(
      '4.replayed-handoff-refused',
      retry.ok === false && (retry.ok ? null : retry.failure.code) === 'ATTESTATION_REPLAYED',
      'the REPLAYED handoff (the same verification message re-presented to Node B) is refused TYPED (ATTESTATION_REPLAYED — the single-use nonce was consumed at verification; P4 verifier-domain freshness)',
    );
    const epochAdvanced = verifyAttestation(transferred.ok ? transferred.attestation : attestationA, {
      bindings: { runId },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH + 1, replayRegistry: new InMemoryReplayRegistry() },
    });
    check(
      '4.epoch-stale-refused',
      epochAdvanced.ok === false && (epochAdvanced.ok ? null : epochAdvanced.failure.code) === 'ATTESTATION_EPOCH_STALE',
      'a verifier epoch advanced past the statement\'s is stale TYPED (ATTESTATION_EPOCH_STALE)',
    );
    const stale = verifyAttestation(transferred.ok ? transferred.attestation : attestationA, {
      bindings: { runId },
      freshness: {
        now: formatUtcTimestamp(epochMsOf(support.clock.utc()) + 600_000),
        currentEpoch: TRIGGER_TEST_EPOCH,
        replayRegistry: new InMemoryReplayRegistry(),
      },
    });
    check(
      '4.expired-refused',
      stale.ok === false && (stale.ok ? null : stale.failure.code) === 'ATTESTATION_EXPIRED',
      'an aged envelope (verifier clock past issuedAt + validity) is expired TYPED (ATTESTATION_EXPIRED)',
    );

    section(`${runLabel} — 5. EXECUTE the dependent step on HOST B (Node B, the desktop device — NOT structurally gated on the section-4 verification)`);
    const runtimeB = nodeRuntime(support.nodes, {
      required: true,
      trustedAttesterKeyIds: [keyA.keyId, keyB.keyId],
      validityMs: 3_600_000,
    });
    const reportB = await runtimeB.resumeAfterHuman(principal, {
      runId,
      hosts: [hostB as ComputerHostAdapter],
      humanOutcome: 'approved',
      humanUserId: operator.id,
      decider: createAckWriteDecider(),
    });
    const ackStep = reportB.steps.find((step) => step.stepId === 'record_ack');
    check(
      '5.dependent-step-executed',
      reportB.state === 'completed' &&
        reportB.failure === null &&
        ackStep?.outcome === 'completed' &&
        ackStep?.nodeId === hostB.nodeId &&
        ackStep?.attestationsAttached === 1 &&
        existsSync(ackFile) &&
        readFileSync(ackFile, 'utf8') === ACK_CONTENT,
      `Node B executes the dependent step (resumeAfterHuman over the DURABLE run: the human approved the handoff): the acknowledgment file is REALLY written (real node:fs bytes asserted) with the exact expected content — NOTE (P3b honest scope): this execution is NOT structurally gated on the section-4 verification (the merged resume surface accepts no admission material; the gap is machine-checked in section 9)`,
    );
    const attestationB = hostB.attestations[0]!;

    // The causal legs, SPLIT per the PR #152 correction:
    //   P5a (verifier domain) — the merged V2-014 verifier ENFORCES the
    //     causalParents dimension: a dependent statement carrying Node A's
    //     execution digest verifies under the causalParents expectation;
    //     the runtime's un-parented shape is refused typed on the dimension.
    //   P5b (unsatisfied dependency, machine-checked right below) — the
    //     RUNTIME-produced dependent attestation carries causalParents: [].
    const historyMid = await support.runs.getRunHistory(principal, runId);
    const durableA = historyMid.attestations.find((binding) => binding.stepId === 'collect')!;
    const durableB = historyMid.attestations.find((binding) => binding.stepId === 'record_ack')!;
    const digestA = durableA.executionDigest;
    const runtimeCausalParents = (durableB.statement as { causalParents: readonly string[] }).causalParents;
    const probeStatement: ExecutionStatement = {
      objectType: EXECUTION_STATEMENT_OBJECT_TYPE,
      statementSchemaVersion: EXECUTION_STATEMENT_SCHEMA_VERSION,
      workflowId,
      workflowVersionId: versionId,
      workflowVersionSemanticDigest: semanticDigest,
      deploymentId: installation.id,
      runId,
      attemptId: 1,
      stepId: 'record_ack',
      nodeId: hostB.nodeId,
      workloadIdentity: 'computer-agent-runtime@desktop',
      executionClass: 'agentic_computer_use',
      capability: 'filesystem.write',
      action: 'cross-device dependent step (causal parent binding probe)',
      inputCommitments: durableB.statement.inputCommitments as readonly string[],
      outputCommitments: durableB.statement.outputCommitments as readonly string[],
      observationCommitments: durableB.statement.observationCommitments as readonly string[],
      evidenceReferences: durableB.statement.evidenceReferences as readonly string[],
      causalParents: [digestA],
      nonce: hostB.nextNonce(),
      epoch: TRIGGER_TEST_EPOCH,
      outcome: 'succeeded',
      executedAt: support.clock.utc(),
      validUntil: formatUtcTimestamp(epochMsOf(support.clock.utc()) + 3_600_000),
    };
    const probeValid = validateExecutionStatement(probeStatement).ok;
    const probeAttestation = signExecutionAttestation({
      statement: probeStatement,
      attesterPrivateKey: keyB.privateKey,
      attesterPublicKeyDer: keyB.publicKeyDer,
      assurance: 'software_signed',
      issuedAt: support.clock.utc(),
    });
    const causalOk = verifyAttestation(probeAttestation, {
      bindings: { runId, attemptId: 1, stepId: 'record_ack', causalParents: [digestA] },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
      attesterKeyIds: [keyB.keyId],
    });
    const causalUnparented = verifyAttestation(attestationB, {
      bindings: { runId, attemptId: 1, stepId: 'record_ack', causalParents: [digestA] },
      freshness: { now: support.clock.utc(), currentEpoch: TRIGGER_TEST_EPOCH, replayRegistry: new InMemoryReplayRegistry() },
    });
    check(
      '5.causal-verifier-p5a',
      probeValid === true &&
        causalOk.ok === true &&
        causalUnparented.ok === false &&
        (causalUnparented.ok ? null : causalUnparented.failure.code) === 'ATTESTATION_BINDING_MISMATCH' &&
        (causalUnparented.ok ? null : causalUnparented.failure.dimension) === 'causalParents',
      `P5a (the V2-014 verifier domain): the causalParents dimension is ENFORCED — a dependent statement carrying Node A's execution digest verifies under the causalParents expectation, while the runtime's un-parented statement shape is refused TYPED on dimension causalParents`,
    );
    check(
      '5.causal-gap-p5b',
      runtimeCausalParents.length === 0,
      `P5b UNSATISFIED DEPENDENCY (machine-checked): the RUNTIME-produced dependent attestation (the real durable record_ack binding) carries causalParents: [] — the merged V2-008 public production surface (StepAttestationMaterial) has NO causal-parent input, so the actual dependent execution does not carry/enforce the causal predecessor binding. Surfaced for the architect (frozen scope: no sibling modifications inside IG-006); this check FAILS loudly the moment the owning module adds a real causal-parent input, forcing this gate to be revisited`,
    );

    section(`${runLabel} — 6. DISCONNECT/RECONNECT + REPLAY: every duplicate converges side-effect-safely`);
    // (a) the handoff ingestion ledger: the SAME envelope delivered twice
    //     converges by stable attestation identity (accepted → duplicate).
    const handoffInbox = new InMemoryAttestationLedger();
    const firstDelivery = handoffInbox.ingest(transferred.ok ? transferred.attestation : attestationA, support.clock.utc());
    const secondDelivery = handoffInbox.ingest(transferred.ok ? transferred.attestation : attestationA, support.clock.utc());
    // (b) the duplicate event (re-connect re-delivery of the trigger).
    const duplicateEvent2 = await inject('POST', `/organizations/${orgId}/workflow-deployments/events`, eventPayload);
    // (c) the duplicate attach command (the runtime's exact command id).
    const convergedAttach = await support.runs.attachAttestation(
      principal,
      { commandId: `cmd-agent-${runId}-att-${attestationA.attestationId}`, correlationId: `agent-${runId}` },
      {
        runId,
        attemptNumber: 1,
        stepId: 'collect',
        attestation: attestationA,
        policy: { trustedAttesterKeyIds: [keyA.keyId] },
      },
    );
    // (d) the re-attach under a NEW command id (the retry that lost its
    //     correlation) — typed rejection through the REAL route + the
    //     DURABLE rejection row.
    const replayedRoute = await inject('POST', `/workflow-runs/runs/${runId}/attestations`, {
      commandId: 'cmd-ig006-dogfooding-replayed-attach-retry',
      correlationId: 'corr-ig006-dogfooding-replayed-attach',
      attemptNumber: 1,
      stepId: 'collect',
      attestation: attestationA,
      policy: { trustedAttesterKeyIds: [keyA.keyId] },
    });
    const historyAfterReplay = await support.runs.getRunHistory(principal, runId);
    const rejectionRow = historyAfterReplay.attestationRejections[0] ?? null;
    // (e) the duplicate host action (the same invocation id re-presented to
    //     Node B's host) converges — NO second write.
    const duplicateAct = await (hostB as ComputerHostAdapter).invoke(`inv-${runId}-a1-record_ack-c0-0002`, {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: null,
      parameters: { path: ACK_PATH, content: ACK_CONTENT },
    });
    check(
      '6.handoff-ledger-converged',
      firstDelivery.kind === 'accepted' && secondDelivery.kind === 'duplicate' && secondDelivery.attestationId === firstDelivery.attestationId && secondDelivery.deliveries === 2,
      `duplicate handoff delivery converges by stable attestation identity (ledger: accepted → duplicate, 2 deliveries, ONE identity)`,
    );
    check(
      '6.duplicate-trigger-converged',
      duplicateEvent2.status === 200 && duplicateEvent2.body.created === false && (duplicateEvent2.body as unknown as { deliveries: unknown[] }).deliveries.length === 0,
      'the re-delivered trigger event converges idempotently (created=false, zero new deliveries)',
    );
    check(
      '6.duplicate-attach-converged',
      convergedAttach.executed === false,
      'the duplicate attach command (the runtime\'s exact command id) converges exactly-once (executed=false — the V2-005 command log)',
    );
    check(
      '6.route-replay-rejected',
      replayedRoute.status === 422 &&
        replayedRoute.body.code === 'RUN_ATTESTATION_REJECTED' &&
        String(replayedRoute.body.message).includes('ATTESTATION_REPLAYED') &&
        rejectionRow !== null &&
        rejectionRow.failureCode === 'ATTESTATION_REPLAYED' &&
        rejectionRow.attestationId === attestationA.attestationId,
      `the re-attach under a NEW command id is rejected TYPED through the real route (HTTP 422 RUN_ATTESTATION_REJECTED carrying ATTESTATION_REPLAYED) and the DURABLE rejection row records the replay`,
    );
    check(
      '6.duplicate-host-action-converged',
      duplicateAct.ok === true && (duplicateAct.ok && duplicateAct.kind === 'acted' ? duplicateAct.converged === true : false) && readFileSync(ackFile, 'utf8') === ACK_CONTENT,
      'the duplicate host action (the same invocation id re-presented to Node B) converges in the host ledger (converged=true) — NO second write, the real file bytes unchanged',
    );

    section(`${runLabel} — 7. the RESULTING RUN/EVIDENCE/PROOF GRAPH (correct + side-effect-safe)`);
    const finalHistory = await support.runs.getRunHistory(principal, runId);
    const finalBindingA = finalHistory.attestations.find((binding) => binding.stepId === 'collect')!;
    const finalBindingB = finalHistory.attestations.find((binding) => binding.stepId === 'record_ack')!;
    const evidenceIds = new Set(finalHistory.evidence.map((evidence) => evidence.id));
    const referencesResolve = finalHistory.attestations.every((binding) =>
      (binding.statement.evidenceReferences as readonly string[]).every((reference) => evidenceIds.has(reference)),
    );
    const humanEvidence = finalHistory.evidence.find((evidence) => evidence.evidenceClass === 'human_confirmation');
    const writeInvocations = finalHistory.invocations.filter((invocation) => invocation.capability === 'filesystem.write');
    const finalRuns = await support.runs.listRunsInOrganization(principal, orgId);
    const finalVersionRead = await inject('GET', `/workflow-repository/workflows/${workflowId}/versions/${versionId}`);
    check(
      '7.run-graph-reconstructs',
      finalHistory.run.state === 'completed' &&
        finalHistory.run.versionId === versionId &&
        finalHistory.run.versionSemanticDigest === semanticDigest &&
        finalHistory.attempts.length === 1 &&
        finalHistory.attempts[0]!.attemptNumber === 1 &&
        JSON.stringify(finalHistory.steps.map((step) => [step.stepId, step.status])) ===
          JSON.stringify([['collect', 'completed'], ['approve', 'completed'], ['record_ack', 'completed']]),
      `the run history reconstructs: the completed run pins the SAME version identity, ONE attempt, all three steps in order (web node → human approval → desktop node)`,
    );
    check(
      '7.attestations-cross-device',
      finalHistory.attestations.length === 2 &&
        finalBindingA.statement.nodeId === hostA.nodeId &&
        finalBindingA.attesterKeyId === keyA.keyId &&
        finalBindingB.statement.nodeId === hostB.nodeId &&
        finalBindingB.attesterKeyId === keyB.keyId &&
        finalBindingA.statement.workflowId === workflowId &&
        finalBindingB.statement.workflowId === workflowId &&
        finalBindingA.statement.workflowVersionSemanticDigest === semanticDigest &&
        finalBindingB.statement.workflowVersionSemanticDigest === semanticDigest &&
        finalBindingA.statement.deploymentId === installation.id &&
        finalBindingB.statement.deploymentId === installation.id &&
        finalBindingA.statement.attemptId === 1 &&
        finalBindingB.statement.attemptId === 1 &&
        new Set([finalBindingA.executionDigest, finalBindingB.executionDigest]).size === 2,
      `BOTH attestation bindings carry the SAME run/version/semantic/attempt identity across TWO DIFFERENT node identities (Node A produced the first, Node B the second — distinct execution digests): one protocol across two devices`,
    );
    check(
      '7.timeline-exact',
      JSON.stringify(finalHistory.timeline.map((entry) => entry.eventName)) === JSON.stringify(EXPECTED_TIMELINE),
      `the protocol timeline is EXACTLY the pinned 31-event sequence (requested → started → the browser loop → verified attestation → paused → resumed → the human approval → the filesystem loop → verified attestation → completed) — every duplicate/replay added ZERO new protocol events`,
    );
    check(
      '7.invocations-and-evidence',
      JSON.stringify(finalHistory.invocations.map((invocation) => invocation.capability)) === JSON.stringify(EXPECTED_INVOCATIONS) &&
        finalHistory.invocations.every((invocation) => invocation.outcome === 'succeeded') &&
        writeInvocations.length === 1 &&
        JSON.stringify([...finalHistory.evidence.map((evidence) => evidence.evidenceClass)].sort()) === JSON.stringify(EXPECTED_EVIDENCE_CLASSES) &&
        humanEvidence?.producerKind === 'human' &&
        humanEvidence?.producerId === operator.id &&
        referencesResolve,
      `the invocation sequence is exactly the cross-device loop (browser.observe/click/observe on Node A, filesystem.read/write/read on Node B, all succeeded, EXACTLY ONE write); the evidence class multiset matches (intent/claim/observation/verification per capability step + ONE human_confirmation produced by the acting human); every attestation evidenceReference resolves to a real evidence record of THIS run`,
    );
    check(
      '7.side-effect-safety',
      finalHistory.attestationRejections.length === 1 &&
        finalRuns.length === 1 &&
        finalRuns[0]!.id === runId &&
        readFileSync(ackFile, 'utf8') === ACK_CONTENT &&
        finalVersionRead.status === 200 &&
        finalVersionRead.raw === versionBodyBefore,
      `FINAL ACCOUNTING (the main run): exactly ONE run, ONE durable rejection row (the typed replay), ONE write effect per host (the acknowledgment bytes EXACT), and the immutable version byte-identical after the whole experiment`,
    );

    section(`${runLabel} — 9. THE P3b GAP PROBE (unsatisfied dependency — machine-checked)`);
    // A second safe cross-device workflow (identical shape, DISTINCT output
    // literals, authored + run through the same real surfaces). Node A
    // executes its step (its own produce→verify→attach gates attach its
    // attestation); then Node B resumes with NO verification leg in between
    // AND a runtime policy that does NOT even trust Node A's attester key.
    // The dependent action still executes — the missing admission coupling,
    // machine-checked (this check FAILS loudly the moment an owning module
    // adds a real admission coupling, forcing this gate to be revisited).
    const probeCreate = await inject('POST', `/organizations/${orgId}/workflow-repository/workflows`, {
      slug: 'ig6-cross-device-intake-ack-p3b-probe',
      name: 'Cross-Device Intake Acknowledgment (P3b Gap Probe)',
      description: 'Browser step on the web device, human handoff approval, device-local acknowledgment write — the admission-coupling gap probe',
      visibility: 'private',
      content: versionContentOf(authorGapProbeDocument()),
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    });
    const probeCreated = probeCreate.body as unknown as {
      workflow: { id: string };
      initialVersion: { id: string; versionNumber: number; contentDigest: string };
    };
    const probeWorkflowId = probeCreated.workflow.id;
    const probeVersionId = probeCreated.initialVersion.id;
    const probeRequested = await support.runs.requestRun(
      principal,
      { commandId: 'cmd-ig006-dogfooding-p3b-gap-probe', correlationId: 'corr-ig006-dogfooding-p3b-gap-probe' },
      {
        organizationId: orgId,
        workflowId: probeWorkflowId,
        versionId: probeVersionId,
        trigger: { type: 'manual', id: 'ig006-dogfooding-p3b-gap-probe' },
        inputCommitments: [sha256Of('ig006-dogfooding-p3b-gap-probe')],
      },
    );
    const probeRunId = probeRequested.result.run.id;
    const probeRuntimeA = nodeRuntime(support.nodes, { required: true, trustedAttesterKeyIds: [keyA.keyId], validityMs: 300_000 });
    const probeReportA = await probeRuntimeA.executeRun(principal, {
      runId: probeRunId,
      hosts: [hostA as ComputerHostAdapter],
      decider: createBrowserSubmitDecider(),
      workflowInputs: { formUrl: FORM_URL },
    });
    // NO TRANSFER, NO VERIFICATION between the pause and the resume — and
    // Node B's runtime policy deliberately does NOT trust Node A's key.
    const probeRuntimeB = nodeRuntime(support.nodes, { required: true, trustedAttesterKeyIds: [keyB.keyId], validityMs: 3_600_000 });
    const probeReportB = await probeRuntimeB.resumeAfterHuman(principal, {
      runId: probeRunId,
      hosts: [hostB as ComputerHostAdapter],
      humanOutcome: 'approved',
      humanUserId: operator.id,
      decider: createAckWriteDecider(),
    });
    const probeAckFile = join(sandboxDir, PROBE_ACK_PATH);
    const probeAckWritten = existsSync(probeAckFile) && readFileSync(probeAckFile, 'utf8') === PROBE_ACK_CONTENT;
    const probeHistory = await support.runs.getRunHistory(principal, probeRunId);
    check(
      '9.p3b-admission-coupling-gap',
      probeCreate.status === 201 &&
        probeCreated.initialVersion.versionNumber === 1 &&
        probeReportA.state === 'paused' &&
        probeReportA.pausedAtStepId === 'approve' &&
        probeReportB.state === 'completed' &&
        probeAckWritten &&
        probeHistory.run.state === 'completed' &&
        probeHistory.attestations.length === 2,
      `P3b UNSATISFIED DEPENDENCY (machine-checked): the dependent action EXECUTED on Node B (the probe acknowledgment file REALLY written, real node:fs bytes asserted) although NO verification of Node A's handoff attestation ever happened at Node B and Node B's runtime policy does not even trust Node A's attester key — the merged public resume surface (V2-008 ResumeAfterHumanInput / V2-005 resume) accepts NO admission/verification material, so the dependent side effect is possible without any admission decision derived from the independently verified Node-A attestation. Surfaced for the architect (frozen scope: no sibling modifications inside IG-006)`,
    );

    const facts: RunFacts = {
      versionContentDigest: created.initialVersion.contentDigest,
      versionSemanticDigest: semanticDigest,
      ackFileBytes: readFileSync(ackFile, 'utf8'),
      intakeFormDigest: sha256Of(INTAKE_FORM_CONTENT),
      runState: finalHistory.run.state,
      stepStatuses: finalHistory.steps.map((step) => [step.stepId, step.status] as const),
      attemptCount: finalHistory.attempts.length,
      timeline: finalHistory.timeline.map((entry) => entry.eventName),
      invocations: finalHistory.invocations.map((invocation) => invocation.capability),
      evidenceClasses: [...finalHistory.evidence.map((evidence) => evidence.evidenceClass)].sort(),
      humanEvidenceProducer: [humanEvidence?.producerKind ?? '—', humanEvidence?.producerId === operator.id ? 'operator' : 'other'],
      attestationBindings: [finalBindingA, finalBindingB].map((binding) => {
        // the durable binding's statement is the stored canonical JSON —
        // cast to the fields the facts compare (all present by construction).
        const statement = binding.statement as {
          nodeId: string;
          executionClass: string;
          capability: string;
          attemptId: number;
          epoch: number;
          outcome: string;
          causalParents: readonly string[];
          evidenceReferences: readonly string[];
        };
        return {
          stepId: binding.stepId ?? '—',
          assurance: binding.assurance,
          nodeId: statement.nodeId,
          statement: {
            executionClass: statement.executionClass,
            capability: statement.capability,
            attemptId: statement.attemptId,
            epoch: statement.epoch,
            outcome: statement.outcome,
            causalParents: statement.causalParents,
            evidenceReferenceCount: statement.evidenceReferences.length,
            evidenceReferencesResolve: statement.evidenceReferences.every((reference) => evidenceIds.has(reference)),
          },
        };
      }),
      distinctExecutionDigests: new Set([finalBindingA.executionDigest, finalBindingB.executionDigest]).size,
      admission: {
        ok: admission.ok,
        attests: admissionFact?.attests ?? '—',
        neverAsserts: admissionFact?.neverAsserts ?? [],
      },
      independentVerifierProcess: {
        ok: independent?.ok === true,
        attests: independent?.attests ?? '—',
        neverAsserts: independent?.neverAsserts ?? [],
      },
      negatives: {
        untrustedAttester: untrusted.ok ? 'ok' : untrusted.failure.code,
        replayedHandoff: retry.ok ? 'ok' : retry.failure.code,
        epochStale: epochAdvanced.ok ? 'ok' : epochAdvanced.failure.code,
        expired: stale.ok ? 'ok' : stale.failure.code,
      },
      causalParentBinding: {
        parentedVerifies: causalOk.ok,
        unparentedRefused: causalUnparented.ok ? 'ok' : causalUnparented.failure.code,
        unparentedDimension: causalUnparented.ok ? '—' : causalUnparented.failure.dimension ?? '—',
      },
      p3bAdmissionGapProbe: {
        probeRunCompleted: probeReportB.state === 'completed',
        probeAckWritten,
        nodeBPolicyTrustsNodeA: false,
      },
      p5bCausalGap: {
        runtimeDependentCausalParentCount: runtimeCausalParents.length,
      },
      replayConvergence: {
        ledgerFirstDelivery: firstDelivery.kind,
        ledgerSecondDelivery: secondDelivery.kind,
        duplicateEventCreated: duplicateEvent2.body.created === false,
        runsAfterDuplicates: finalRuns.length,
        duplicateAttachExecuted: convergedAttach.executed === false,
        routeReplayStatus: replayedRoute.status,
        routeReplayCode: String(replayedRoute.body.code),
        durableRejectionCode: rejectionRow?.failureCode ?? '—',
        durableRejectionCount: finalHistory.attestationRejections.length,
        duplicateHostActionConverged: duplicateAct.ok && duplicateAct.kind === 'acted' ? duplicateAct.converged === true : false,
        writeInvocationCount: writeInvocations.length,
      },
    };

    transcript.push(`\n# ${runLabel} summary: ${failures === 0 ? 'all checks PASS' : `${failures} FAILED`}`);
    return { text: transcript.join('\n'), facts };
  } finally {
    await app!.close();
    await support.teardown();
    activeSupport = null;
  }
}

async function main(): Promise<void> {
  const one = await runExperiment('RUN 1');
  const failuresOne = failures;
  transcript.length = 0;
  failures = 0;
  const two = await runExperiment('RUN 2');
  const failuresTwo = failures;

  const factsEqual = JSON.stringify(one.facts) === JSON.stringify(two.facts);
  const normalizedOne = normalizeTranscript(one.text);
  const normalizedTwo = normalizeTranscript(two.text);
  const deterministic = normalizedOne === normalizedTwo;

  transcript.length = 0;
  transcript.push(two.text);
  transcript.push('');
  transcript.push('(RUN 1 transcript: identical to RUN 2 above after normalizing run-scoped bookkeeping');
  transcript.push(' — uuid-shaped ids, the derived dep_/sub_/evt_/dlv_/wfr_/wfre_/… ids, the Ed25519');
  transcript.push(' key-derived material (attester key ids, attestation ids, execution digests — real');
  transcript.push(' Ed25519 cannot be seeded), the mkdtemp sandbox suffixes and the run labels. The');
  transcript.push(' deterministic structured facts — version content/semantic digests, node identities,');
  transcript.push(' the timeline, the invocation/evidence sequences, every typed outcome — are compared');
  transcript.push(' byte-for-byte across the two runs.)');
  transcript.push('');
  transcript.push(`determinism (structured facts): ${factsEqual ? 'IDENTICAL across the two fresh-stack runs' : 'DIVERGED'}`);
  transcript.push(`determinism (normalized transcripts): ${deterministic ? 'IDENTICAL' : 'DIVERGED (see diff)'}`);
  if (!deterministic) {
    const a = normalizedOne.split('\n');
    const b = normalizedTwo.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        transcript.push(`  diff line ${i}: RUN1=${JSON.stringify(a[i] ?? '')}`);
        transcript.push(`  diff line ${i}: RUN2=${JSON.stringify(b[i] ?? '')}`);
      }
    }
  }
  transcript.push('');
  // The PR #152 correction verdict: the gate FAILS CLOSED on the two
  // unsatisfied dependencies (surfaced, machine-confirmed) instead of
  // claiming IG-006 PASS. Exit 3 = fail-closed verdict (all machine-checkable
  // checks green + deterministic, gaps present); exit 1 = experiment failure;
  // exit 0 = only reachable after the gaps are resolved AND this runner is
  // revisited (the gap checks fail loudly the moment the coupling exists).
  const p3bGapPresent =
    one.facts.p3bAdmissionGapProbe.probeRunCompleted === true &&
    one.facts.p3bAdmissionGapProbe.probeAckWritten === true &&
    one.facts.p3bAdmissionGapProbe.nodeBPolicyTrustsNodeA === false &&
    two.facts.p3bAdmissionGapProbe.probeRunCompleted === true &&
    two.facts.p3bAdmissionGapProbe.probeAckWritten === true;
  const p5bGapPresent =
    one.facts.p5bCausalGap.runtimeDependentCausalParentCount === 0 &&
    two.facts.p5bCausalGap.runtimeDependentCausalParentCount === 0;
  const experimentOk = failuresOne === 0 && failuresTwo === 0 && factsEqual && deterministic;
  const gatePass = experimentOk && !p3bGapPresent && !p5bGapPresent;
  transcript.push('GATE VERDICT: FAIL — UNSATISFIED DEPENDENCIES');
  if (p3bGapPresent) {
    transcript.push('  - P3b admission coupling: Node B\'s independent verification of the Node-A attestation is NOT');
    transcript.push('    consumed by the dependent action\'s admission — the merged V2-008 ResumeAfterHumanInput and');
    transcript.push('    the V2-005 resume command accept no admission/verification material, and the runtime walk');
    transcript.push('    never consults prior-step attestation bindings (machine-confirmed by the section-9 probe on');
    transcript.push('    both fresh-stack runs; the full key set of the public resume surface is pinned in the gate test).');
  }
  if (p5bGapPresent) {
    transcript.push('  - P5b runtime causal chain: the runtime-produced dependent attestation carries causalParents: []');
    transcript.push('    — the merged V2-008 public production surface (StepAttestationMaterial) has no causal-parent');
    transcript.push('    input, so the actual dependent execution does not carry/enforce the causal predecessor');
    transcript.push('    binding (machine-confirmed on both fresh-stack runs; the surface key set is pinned in the gate');
    transcript.push('    test).');
  }
  transcript.push('  (surfaced per the architect\'s PR #152 REQUEST-CHANGES directive; resolution requires a public');
  transcript.push('   admission/causal coupling surface in the owning module — the architect\'s disposition. V2-015');
  transcript.push('   remains blocked exactly as the frozen roadmap requires.)');
  transcript.push('');
  transcript.push(
    `DOGFOODING RESULT: ${gatePass
      ? 'PASS (the gaps are resolved — every proof on the runtime composition path)'
      : experimentOk
        ? 'FAIL (fail-closed: 2 unsatisfied dependencies; every machine-checkable check PASSES and is deterministic across the two fresh runs)'
        : 'FAIL (experiment failure — see the checks above)'}`,
  );
  const output = transcript.join('\n');
  // eslint-disable-next-line no-console
  console.log(output);
  console.error(`normalized-transcript-sha256: ${sha256Of(normalizedTwo)}`);
  process.exit(experimentOk ? (gatePass ? 0 : 3) : 1);
}

/**
 * Normalize run-scoped bookkeeping (uuid-shaped org/user/version/installation
 * ids — full AND norm()-truncated forms — the derived dep_/sub_/evt_/dlv_/
 * wfw_/wfwv_/wfin_/wfr_… ids, the Ed25519 key-derived material, sandbox
 * suffixes, run labels). Deterministic content is preserved.
 */
function normalizeTranscript(text: string): string {
  return text
    .replace(/RUN 1|RUN 2/g, 'RUN <n>')
    .replace(/IG-006 Dogfooding Org RUN <n>/g, 'IG-006 Dogfooding Org <run>')
    // uuid-shaped ids (organizations, users, versions, installations)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    // deterministic-prefix derived ids (full form)
    .replace(/\b[a-z]{2,10}_[0-9a-f]{10,}\b/g, '<derived_id>')
    // sandbox directories and transfer material
    .replace(/ig-006-dogfood-[A-Za-z0-9]+/g, 'ig-006-dogfood-<sandbox>')
    // norm()-truncated id-like tokens (first-slice … last-slice)
    .replace(/\b[0-9a-f-]{3,10}…[0-9a-f]{4}\b/g, '<id>')
    .replace(/\b[a-z]{2,10}_[0-9a-f]{3,6}…[0-9a-f]{4}\b/g, '<id>');
}

main().catch((error) => {
  console.error('IG-006 dogfooding runner crashed:', error);
  process.exit(1);
});

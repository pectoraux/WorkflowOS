/**
 * V2-008 — human pause + takeover integration on the REAL stack (real
 * PGlite + V2-002 + V2-005 DefaultWorkflowRunService as the runtime's
 * ComputerAgentRunRecorder + real V2-004 registration + real Ed25519 keys).
 *
 * Pins the Work Order's required regressions at the real composition:
 *   - a HUMAN approval node is a pause point: the run pauses at it through
 *     the real V2-005 pause command (attempt suspended, resume-to-exact-step);
 *   - resumeAfterHuman('approved') records the human_confirmation evidence
 *     (producerKind 'human', producerId = the acting human's user id),
 *     completes the human step, and the run completes — timeline carrying
 *     workflow.run.paused → workflow.run.resumed → workflow.run.completed,
 *     ONE attempt (the same attempt continues — no new attempt);
 *   - the decider 'takeover' decision pauses the run (takeoverRequested);
 *   - requestTakeover on the paused run opens the takeover session; on a
 *     NON-paused run it is the typed ComputerAgentError
 *     COMPUTER_AGENT_RUN_NOT_PAUSED (fail-closed);
 *   - finishTakeover complete-step hands the run back and completes it.
 *
 * REAL-COMPOSITION FINDINGS (pinned honestly; NEVER papered over — the
 * module source is out of this battery's write scope and is NOT edited):
 *   [F-A] performTakeoverAction against the REAL V2-005 command surface is
 *         typed-rejected RUN_NOT_RUNNING: the runtime records takeover
 *         invocations while the run is PAUSED, but the real V2-005 boundary
 *         records invocations only while the run is RUNNING. The unit
 *         battery's in-memory recorder double accepted this (it imposes no
 *         state constraint); the real composition cannot record the human's
 *         host actions at all. Pinned by the typed rejection + the untouched
 *         host environment + the durable command-log rejection record.
 *   [F-B] finishTakeover mode 'hand-back' re-drives the paused agentic step
 *         from the plan entry; the runtime's per-decision intent-evidence
 *         command ids (`ev-intent-<step>-decision-<n>`) collide across
 *         drives (same command id, DIFFERENT decision payload) → the real
 *         V2-005 exactly-once boundary rejects RUN_COMMAND_PAYLOAD_CONFLICT.
 *         Only 'complete-step' (no decider re-drive) hands back cleanly.
 *   [F-C] after resumeAfterHuman completes the human step, the runtime's
 *         re-walk starts from the plan entry and SKIPS already-completed
 *         units without enqueueing their successors — the declared
 *         post-approval step ('notify') is never dispatched. The run still
 *         completes (the pinned assertion), but the approval flow's
 *         successor step does not execute on the real stack.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type WorkflowRunHistory } from '../../../src/workflow-runs/index.js';
import {
  buildComputerAgentTestStack,
  buildAgenticWriteDocument,
  buildApprovalFlowDocument,
  createObserveWriteVerifyDecider,
  createTakeoverDecider,
  freshDesktopEnvironment,
  newAttesterKey,
  attestationPolicyFor,
  TRIAGE_REPORT_CONTENT,
  WORKFLOW_INPUTS,
  type ComputerAgentTestStack,
} from './computer-agent-test-support.js';

const REPORT_PATH = WORKFLOW_INPUTS.reportPath;
const HUMAN_USER_ID = 'v2-008-human-1';

describe('V2-008 computer-agent runtime — human pause + takeover on the real stack', () => {
  let harness: ComputerAgentTestStack;

  beforeAll(async () => {
    harness = await buildComputerAgentTestStack();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it('human approval node pauses the run; resumeAfterHuman(approved) records human_confirmation and completes (one attempt)', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const key = newAttesterKey();
    const { host } = harness.attachDesktopHost({
      nodes,
      keySeed: 'pause-approval-desktop',
      environment,
      attesterKey: key,
    });
    const runtime = harness.createRuntime({
      nodes,
      policy: { attestation: attestationPolicyFor([host]) },
    });
    const authored = await harness.authorWorkflow({ document: buildApprovalFlowDocument(), slug: 'approval-flow' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'pause-approval',
    });

    // ---- drive 1: the agentic step completes, the run pauses AT the human node:
    const paused = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [host],
      decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: TRIAGE_REPORT_CONTENT }),
      workflowInputs: { reportPath: REPORT_PATH },
    });
    expect(paused.state).toBe('paused');
    expect(paused.pausedAtStepId).toBe('approve');
    expect(paused.takeoverRequested).toBe(false);
    expect(environment.readFile(REPORT_PATH)).toBe(TRIAGE_REPORT_CONTENT); // the real effect
    expect(paused.steps.map((step) => `${step.stepId}:${step.outcome}`)).toEqual(['organize:completed', 'approve:paused']);

    const midHistory: WorkflowRunHistory = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(midHistory.run.state).toBe('paused');
    expect(midHistory.attempts.length).toBe(1);
    expect(midHistory.attempts[0]!.state).toBe('suspended');
    expect(midHistory.attempts[0]!.pausedAtStepId).toBe('approve'); // resume-to-exact-step
    expect(midHistory.steps.map((step) => `${step.stepId}:${step.status}`)).toEqual(['organize:completed', 'approve:started']);

    // ---- the human approves; the run resumes and completes:
    const resumed = await runtime.resumeAfterHuman(harness.principal, {
      runId: run.id,
      hosts: [host],
      humanOutcome: 'approved',
      humanUserId: HUMAN_USER_ID,
      workflowInputs: { reportPath: REPORT_PATH },
    });
    expect(resumed.state).toBe('completed');
    expect(resumed.pausedAtStepId).toBeNull();
    expect(resumed.failure).toBeNull();

    const history: WorkflowRunHistory = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(history.run.state).toBe('completed');

    // the human step completed with the human-confirmation evidence:
    const approveStep = history.steps.find((step) => step.stepId === 'approve');
    expect(approveStep?.status).toBe('completed');
    expect(approveStep?.outcome).toBe('succeeded');
    const confirmations = history.evidence.filter((evidence) => evidence.evidenceClass === 'human_confirmation');
    expect(confirmations.length).toBe(1);
    expect(confirmations[0]!.producerKind).toBe('human');
    expect(confirmations[0]!.producerId).toBe(HUMAN_USER_ID);
    expect(confirmations[0]!.stepId).toBe('approve');

    // ONE attempt only: the same attempt continued (resume-to-exact-step):
    expect(history.attempts.length).toBe(1);
    expect(history.attempts[0]!.attemptNumber).toBe(1);
    expect(history.attempts[0]!.state).toBe('ended');

    // the timeline carries paused → resumed → completed in order:
    const names = history.timeline.map((entry) => entry.eventName);
    expect(names).toContain('workflow.run.paused');
    expect(names).toContain('workflow.run.resumed');
    expect(names.indexOf('workflow.run.paused')).toBeLessThan(names.indexOf('workflow.run.resumed'));
    expect(names.indexOf('workflow.run.resumed')).toBeLessThan(names.indexOf('workflow.run.completed'));
    // [F-C] documented above: the declared post-approval step 'notify' is NOT
    // dispatched by the resume re-walk (the run completes without it).
  });

  it('decider takeover pauses the run and opens a session; performTakeoverAction is typed-rejected by the real boundary [F-A] and the host is untouched', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const { host, nodeId } = harness.attachDesktopHost({ nodes, keySeed: 'takeover-desktop', environment });
    const runtime = harness.createRuntime({ nodes });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'agentic-write-takeover' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'takeover-pause',
    });

    // ---- the agent requests takeover → the run pauses at the agentic step:
    const paused = await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [host],
      decider: createTakeoverDecider('human confirmation of the destination path is required'),
      workflowInputs: { reportPath: REPORT_PATH },
    });
    expect(paused.state).toBe('paused');
    expect(paused.pausedAtStepId).toBe('organize');
    expect(paused.takeoverRequested).toBe(true);
    expect(environment.readFile(REPORT_PATH)).toBeNull(); // nothing was written

    // ---- the human opens a takeover session on the paused run:
    const session = await runtime.requestTakeover(harness.principal, {
      runId: run.id,
      stepId: 'organize',
      userId: HUMAN_USER_ID,
      host,
    });
    expect(session.id).toBe(`takeover-${run.id}-organize`);
    expect(session.userId).toBe(HUMAN_USER_ID);
    expect(session.nodeId).toBe(nodeId);

    // ---- [F-A] the human's first protocol action is typed-rejected by the
    // real V2-005 boundary: invocations record only while the run is RUNNING:
    await expect(
      runtime.performTakeoverAction(session, harness.principal, host, {
        kind: 'observe',
        capability: 'filesystem.read',
        subject: REPORT_PATH,
      }),
    ).rejects.toMatchObject({ name: 'WorkflowRunError', code: 'RUN_NOT_RUNNING' });

    // the host was untouched (the recording precedes the host invocation):
    expect(environment.readFile(REPORT_PATH)).toBeNull();
    const history = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(history.invocations.length).toBe(0); // no invocation row was created
    expect(history.evidence.filter((evidence) => evidence.evidenceClass === 'human_confirmation').length).toBe(0);
    // the typed rejection IS durably recorded in the command log:
    const rejectedCommand = history.commands.find(
      (command) => command.result.ok === false && command.result.code === 'RUN_NOT_RUNNING',
    );
    expect(rejectedCommand).toBeDefined();
    expect(rejectedCommand?.commandType).toBe('record_invocation_requested');
    // the run is still paused with the suspended attempt (fail-closed, no state change):
    expect(history.run.state).toBe('paused');
    expect(history.attempts[0]!.state).toBe('suspended');
  });

  it('finishTakeover complete-step hands the run back and completes it; requestTakeover on the completed run is COMPUTER_AGENT_RUN_NOT_PAUSED', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const { host, nodeId } = harness.attachDesktopHost({ nodes, keySeed: 'takeover-finish-desktop', environment });
    const runtime = harness.createRuntime({ nodes });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'agentic-write-finish' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'takeover-finish',
    });

    await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [host],
      decider: createTakeoverDecider('human completion of the report step is required'),
      workflowInputs: { reportPath: REPORT_PATH },
    });
    const session = await runtime.requestTakeover(harness.principal, {
      runId: run.id,
      stepId: 'organize',
      userId: HUMAN_USER_ID,
      host,
    });

    // [F-A] prevents performTakeoverAction on the real boundary; the
    // human-completed hand-back (complete-step) needs no host action:
    const final = await runtime.finishTakeover(harness.principal, session, {
      mode: 'complete-step',
      hosts: [host],
      workflowInputs: { reportPath: REPORT_PATH },
    });
    expect(final.state).toBe('completed');
    expect(final.steps.length).toBe(0); // the walk skipped the completed step
    const history = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(history.run.state).toBe('completed');
    expect(history.steps[0]!.stepId).toBe('organize');
    expect(history.steps[0]!.status).toBe('completed');
    expect(history.steps[0]!.outcome).toBe('succeeded');
    expect(history.timeline.map((entry) => entry.eventName)).toContain('workflow.run.completed');
    void nodeId;

    // a takeover request on the (now terminal, non-paused) run is the typed
    // fail-closed rejection — never a silent session:
    await expect(
      runtime.requestTakeover(harness.principal, {
        runId: run.id,
        stepId: 'organize',
        userId: HUMAN_USER_ID,
        host,
      }),
    ).rejects.toMatchObject({ name: 'ComputerAgentError', code: 'COMPUTER_AGENT_RUN_NOT_PAUSED' });
  });

  it('[F-B] finishTakeover hand-back (decider re-drive) hits the exactly-once boundary: RUN_COMMAND_PAYLOAD_CONFLICT', async () => {
    const nodes = harness.freshNodeDirectory();
    const environment = freshDesktopEnvironment();
    const { host } = harness.attachDesktopHost({ nodes, keySeed: 'takeover-handback-desktop', environment });
    const runtime = harness.createRuntime({ nodes });
    const authored = await harness.authorWorkflow({ document: buildAgenticWriteDocument(), slug: 'agentic-write-handback' });
    const run = await harness.requestRun({
      workflowId: authored.workflowId,
      versionId: authored.versionId,
      triggerId: 'takeover-handback',
    });

    await runtime.executeRun(harness.principal, {
      runId: run.id,
      hosts: [host],
      decider: createTakeoverDecider('human confirmation of the destination path is required'),
      workflowInputs: { reportPath: REPORT_PATH },
    });
    const session = await runtime.requestTakeover(harness.principal, {
      runId: run.id,
      stepId: 'organize',
      userId: HUMAN_USER_ID,
      host,
    });

    // hand-back re-drives the agentic step with a COMPLETING decider; the
    // runtime's first-decision intent evidence command id was already used
    // by the takeover decision (same id, different payload) → the real
    // exactly-once boundary rejects it typed:
    await expect(
      runtime.finishTakeover(harness.principal, session, {
        mode: 'hand-back',
        hosts: [host],
        decider: createObserveWriteVerifyDecider({ reportPath: REPORT_PATH, content: 'HUMAN-CONFIRMED' }),
        workflowInputs: { reportPath: REPORT_PATH },
      }),
    ).rejects.toMatchObject({ name: 'WorkflowRunError', code: 'RUN_COMMAND_PAYLOAD_CONFLICT' });

    // the run was resumed by the (failed) hand-back and stays non-terminal in
    // the DB with the step still started (the conflict is durable + typed):
    const history = await harness.runService.getRunHistory(harness.principal, run.id);
    expect(['running', 'paused']).toContain(history.run.state);
    expect(history.steps[0]!.status).toBe('started');
    expect(environment.readFile(REPORT_PATH)).toBeNull();
  });
});

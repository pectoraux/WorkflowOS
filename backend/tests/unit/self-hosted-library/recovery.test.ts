import { describe, it, expect } from 'vitest';
import {
  planFailedWorkflowRecovery,
  publishFirstPartyVersion,
  artifactByKind,
  type FailedRunFacts,
  type FailedWorkflowRecoveryPlan,
  type FirstPartyPinFacts,
  type FirstPartyTargetVersionFacts,
  type FirstPartyInstallPort,
  type PlanFailedWorkflowRecoveryInput,
} from '../../../src/self-hosted-library/index.js';
import { CORE_SELF_HOSTING_PROHIBITIONS } from '../../../src/architecture-checkpoints/index.js';
import { createWorkflowIrBuilder } from '../../../src/workflow-ir/index.js';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import { makeDevEnvironment, DEV_RUN_ID, DEV_PRINCIPAL, DEV_PROTOCOL } from './helpers.js';

/**
 * V2-013 Task 6 — the failed-workflow recovery battery.
 *
 * Proves (the frozen regression "failed-workflow recovery"):
 *   - a terminally FAILED first-party run → retry_same_pin: a NEW run
 *     against the SAME pinned version (the failed run is never
 *     resurrected; the plan carries the pin identity);
 *   - an IN-PROGRESS run is NOT recoverable (typed block — a run is
 *     never interrupted or resurrected by the plan);
 *   - a run of a DIFFERENT workflow/version → typed scope mismatch;
 *   - retry with a DRIFTED installation pin → blocked (the pin never
 *     moves silently; an explicit advance is required);
 *   - advance_version → an EXPLICIT governed transition (to a DIFFERENT
 *     version of the SAME workflow; the failed run stays failed);
 *   - an advance to the manifest's OWN version → typed invalid;
 *   - a weakened boundary model at recovery time → blocked (governance
 *     preserved at every recovery decision).
 */

function realBoundary() {
  return {
    may: ['plan its own implementation'],
    mayNot: [...CORE_SELF_HOSTING_PROHIBITIONS],
    coreProhibitions: [...CORE_SELF_HOSTING_PROHIBITIONS],
  };
}

function failedRun(overrides: Partial<FailedRunFacts> = {}): FailedRunFacts {
  return {
    runId: `${DEV_RUN_ID}-failed`,
    workflowId: 'PLACEHOLDER',
    versionId: 'PLACEHOLDER',
    state: 'failed',
    ...overrides,
  };
}

function input(
  manifest: PlanFailedWorkflowRecoveryInput['manifest'],
  run: FailedRunFacts,
  pinFacts: FirstPartyPinFacts,
  request: PlanFailedWorkflowRecoveryInput['request'],
  boundary = realBoundary(),
): PlanFailedWorkflowRecoveryInput {
  return {
    manifest,
    failedRun: run,
    pinFacts,
    boundary,
    artifact: artifactByKind('dogfooding')!,
    request,
  };
}

/** The mutated dogfooding document (a genuinely NEW version — a changed task). */
function mutatedDogfoodingDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('install_workflow')
    .addWorkflowInput({ name: 'procedureKind', type: { kind: 'string' } })
    .addNode({
      id: 'install_workflow',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'workflow.execute' },
      capabilityRequirements: ['workflow.execute'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'done', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'execute_workflow',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Execute the installed workflow end-to-end through the real execution authorities (MUTATED for the advance-target fixture)' },
      capabilityRequirements: ['workflow.execute', 'filesystem.read'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'done', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'record_evidence',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Record the dogfooding evidence and corrective observations' },
      capabilityRequirements: ['filesystem.write'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'done', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addEdge({ from: 'install_workflow', to: 'execute_workflow', on: 'success' })
    .addEdge({ from: 'execute_workflow', to: 'record_evidence', on: 'success' })
    .build();
}

describe('V2-013 failed-workflow recovery — typed plans', () => {
  it('a terminally FAILED run → retry_same_pin (a NEW run against the SAME pin; never in-place resurrection)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, { action: 'retry_same_pin' }),
    );
    expectPlan(plan, 'retry_same_pin');
    if (plan.kind === 'retry_same_pin') {
      expect(plan.workflowId).toBe(manifest.workflowId);
      expect(plan.versionId).toBe(manifest.versionId);
      expect(plan.installationId).toBe(manifest.installationId);
      expect(plan.failedRunId).toBe(`${DEV_RUN_ID}-failed`);
    }
  });

  it('an IN-PROGRESS run is NOT recoverable (typed block)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId, state: 'running' }), pinFacts, { action: 'retry_same_pin' }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RUN_NOT_FAILED');
    }
  });

  it('a run of a DIFFERENT version → typed scope mismatch (a retry never targets a foreign run)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: 'wfwv-foreign' }), pinFacts, { action: 'retry_same_pin' }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RUN_SCOPE_MISMATCH');
    }
  });

  it('retry with a DRIFTED installation pin → blocked (the pin never moves silently)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const drifted: FirstPartyPinFacts = { ...pinFacts, versionId: 'wfwv-moved', versionNumber: 2, contentDigest: 'digest-moved' };
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), drifted, { action: 'retry_same_pin' }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_ADVANCE_INVALID');
    }
  });

  it('advance_version → an EXPLICIT governed transition to a REAL PUBLISHED target version of the SAME workflow (facts read back from the authority)', async () => {
    const { manifests, pinFacts, port } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    // a REAL new version published through the module's own explicit
    // transition (create-or-converge over the V2-002-shaped port)
    const published = await publishFirstPartyVersion(
      port,
      DEV_PRINCIPAL,
      manifest.workflowId,
      mutatedDogfoodingDocument(),
      DEV_PROTOCOL,
    );
    expect(published.created).toBe(true);
    expect(published.versionNumber).toBe(2);
    // the authoritative target facts: the version record read back from the
    // authority (V2-002's WorkflowVersion identity shape)
    const targetVersion: FirstPartyTargetVersionFacts = {
      version: {
        id: published.versionId,
        workflowId: manifest.workflowId,
        versionNumber: published.versionNumber,
        contentDigest: published.contentDigest,
      },
    };
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: published.versionId,
        targetVersion,
      }),
    );
    expectPlan(plan, 'advance_version');
    if (plan.kind === 'advance_version') {
      expect(plan.workflowId).toBe(manifest.workflowId);
      expect(plan.fromVersionId).toBe(manifest.versionId);
      expect(plan.toVersionId).toBe(published.versionId);
      expect(plan.failedRunId).toBe(`${DEV_RUN_ID}-failed`);
    }
  });

  it('an advance to the manifest OWN version → typed invalid (not a transition — even with the manifest\'s own version facts supplied)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: manifest.versionId,
        // even well-formed facts pointing at the manifest's OWN version are
        // not a transition: the same-version check fires first (the advance
        // must target a DIFFERENT version, proven or not)
        targetVersion: {
          version: {
            id: manifest.versionId,
            workflowId: manifest.workflowId,
            versionNumber: manifest.versionNumber,
            contentDigest: manifest.contentDigest,
          },
        },
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_ADVANCE_INVALID');
    }
  });

  it('a WEAKENED boundary model at recovery time → blocked (governance preserved at every recovery decision)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const weakened = {
      may: ['plan its own implementation'],
      mayNot: CORE_SELF_HOSTING_PROHIBITIONS.slice(0, 7),
      coreProhibitions: CORE_SELF_HOSTING_PROHIBITIONS.slice(0, 7),
    };
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, { action: 'retry_same_pin' }, weakened),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_BOUNDARY_DENIED');
    }
  });
});

// =============================================================================
// The PR #160 Blocker-2 correction — the advance target is PROVEN by
// authoritative version facts.
//
// The architect's finding: `planFailedWorkflowRecovery()` accepted ANY
// `toVersionId` different from the current version without proving the
// target exists, belongs to the same workflow, or is an authoritative
// published version — and the previous test explicitly accepted a
// SYNTHETIC target, making the hole contractual, not hypothetical.
// =============================================================================

describe('V2-013 failed-workflow recovery — the advance target is proven by authoritative version facts (PR #160 Blocker-2)', () => {
  it('a SYNTHETIC target (no authority facts at all) → SELF_HOSTING_RECOVERY_TARGET_UNPROVEN (fail-closed; a synthetic target is never an advance)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts,
        // the old hole's exact shape: a bare toVersionId that exists nowhere
        // (intentionally malformed — the runtime must reject it typed)
        { action: 'advance_version', toVersionId: 'wfwv-synthetic-target' } as unknown as PlanFailedWorkflowRecoveryInput['request'],
      ),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_UNPROVEN');
      expect(plan.failure.detail).toContain('wfwv-synthetic-target');
    }
  });

  it('MALFORMED target facts (missing identity fields) → SELF_HOSTING_RECOVERY_TARGET_UNPROVEN (fail-closed on the shape)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: 'wfwv-malformed-target',
        targetVersion: { version: { workflowId: manifest.workflowId } } as unknown as FirstPartyTargetVersionFacts,
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_UNPROVEN');
    }
  });

  it('facts proving a DIFFERENT version than the requested target → SELF_HOSTING_RECOVERY_TARGET_UNPROVEN (the facts must bind the exact target)', async () => {
    const { manifests, pinFacts, port } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const published = await publishFirstPartyVersion(
      port,
      DEV_PRINCIPAL,
      manifest.workflowId,
      mutatedDogfoodingDocument(),
      DEV_PROTOCOL,
    );
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        // requests a version the facts do NOT prove
        toVersionId: 'wfwv-some-other-version',
        targetVersion: {
          version: {
            id: published.versionId,
            workflowId: manifest.workflowId,
            versionNumber: published.versionNumber,
            contentDigest: published.contentDigest,
          },
        },
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_UNPROVEN');
      expect(plan.failure.detail).toContain('wfwv-some-other-version');
    }
  });

  it('facts of a FOREIGN workflow → SELF_HOSTING_RECOVERY_TARGET_UNPROVEN (an advance never crosses workflows)', async () => {
    const { manifests, pinFacts, port } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    // a REAL version of a DIFFERENT first-party workflow (the testing kind)
    const testingManifest = manifests.find((m) => m.kind === 'testing')!;
    const foreignPublished = await publishFirstPartyVersion(
      port,
      DEV_PRINCIPAL,
      testingManifest.workflowId,
      mutatedDogfoodingDocument(),
      DEV_PROTOCOL,
    );
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: foreignPublished.versionId,
        targetVersion: {
          version: {
            id: foreignPublished.versionId,
            workflowId: testingManifest.workflowId,
            versionNumber: foreignPublished.versionNumber,
            contentDigest: foreignPublished.contentDigest,
          },
        },
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_UNPROVEN');
      expect(plan.failure.detail).toContain('SAME workflow');
    }
  });
});

function expectPlan(plan: FailedWorkflowRecoveryPlan, kind: 'retry_same_pin' | 'advance_version' | 'blocked') {
  if (plan.kind !== kind) {
    throw new Error(`expected plan kind ${kind}, got ${plan.kind}${plan.kind === 'blocked' ? ` (${plan.failure.code}: ${plan.failure.detail})` : ''}`);
  }
}

async function fixture(): Promise<{ manifests: Awaited<ReturnType<typeof makeDevEnvironment>>['manifests']; pinFacts: FirstPartyPinFacts; port: FirstPartyInstallPort }> {
  const { port, manifests } = await makeDevEnvironment();
  const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
  return {
    port,
    manifests,
    pinFacts: {
      organizationId: 'org-dev-environment',
      installationId: manifest.installationId,
      workflowId: manifest.workflowId,
      versionId: manifest.versionId,
      versionNumber: manifest.versionNumber,
      contentDigest: manifest.contentDigest,
    },
  };
}

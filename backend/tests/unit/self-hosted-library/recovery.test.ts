import { describe, it, expect } from 'vitest';
import {
  planFailedWorkflowRecovery,
  artifactByKind,
  type FailedRunFacts,
  type FailedWorkflowRecoveryPlan,
  type FirstPartyPinFacts,
  type PlanFailedWorkflowRecoveryInput,
} from '../../../src/self-hosted-library/index.js';
import { CORE_SELF_HOSTING_PROHIBITIONS } from '../../../src/architecture-checkpoints/index.js';
import { makeDevEnvironment, DEV_RUN_ID } from './helpers.js';

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

  it('advance_version → an EXPLICIT governed transition to a DIFFERENT version of the SAME workflow', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, { action: 'advance_version', toVersionId: 'wfwv-next-explicit' }),
    );
    expectPlan(plan, 'advance_version');
    if (plan.kind === 'advance_version') {
      expect(plan.workflowId).toBe(manifest.workflowId);
      expect(plan.fromVersionId).toBe(manifest.versionId);
      expect(plan.toVersionId).toBe('wfwv-next-explicit');
      expect(plan.failedRunId).toBe(`${DEV_RUN_ID}-failed`);
    }
  });

  it('an advance to the manifest OWN version → typed invalid (not a transition)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, { action: 'advance_version', toVersionId: manifest.versionId }),
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

function expectPlan(plan: FailedWorkflowRecoveryPlan, kind: 'retry_same_pin' | 'advance_version' | 'blocked') {
  if (plan.kind !== kind) {
    throw new Error(`expected plan kind ${kind}, got ${plan.kind}${plan.kind === 'blocked' ? ` (${plan.failure.code}: ${plan.failure.detail})` : ''}`);
  }
}

async function fixture(): Promise<{ manifests: Awaited<ReturnType<typeof makeDevEnvironment>>['manifests']; pinFacts: FirstPartyPinFacts }> {
  const { manifests } = await makeDevEnvironment();
  const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
  return {
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

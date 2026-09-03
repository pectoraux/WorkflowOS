/**
 * V2-013 — internal/failed-workflow recovery (typed plans).
 *
 * The typed NEXT governed action for a failed first-party run. The plan
 * is DATA — this module never drives the run lifecycle (V2-005 stays the
 * Run authority; the caller executes the plan through the real
 * authorities).
 *
 * Fail-closed rules (the frozen work-order regressions):
 *   - only a terminal FAILED run is recoverable (never in-progress);
 *   - the failed run must belong to the manifest's workflow AND exact
 *     pinned version (scope match);
 *   - `retry_same_pin` targets the SAME pinned version as a NEW run —
 *     the failed run is never resurrected in place, and the pin NEVER
 *     moves silently (a drifted installation pin blocks the retry and
 *     demands an explicit advance);
 *   - `advance_version` is ONLY an explicit governed transition to a
 *     different version of the SAME workflow (publish + install the new
 *     pin first; the failed run stays failed — durable history);
 *   - the self-hosting permission boundary is re-evaluated at recovery
 *     time (governance preserved: a weakened model or an out-of-boundary
 *     artifact blocks the recovery).
 */

import type {
  FailedWorkflowRecoveryPlan,
  PlanFailedWorkflowRecoveryInput,
} from '../types.js';
import { evaluateSelfHostingBoundary } from './boundary.js';

/** Plan the recovery for one failed first-party run. */
export function planFailedWorkflowRecovery(input: PlanFailedWorkflowRecoveryInput): FailedWorkflowRecoveryPlan {
  // 1. the boundary holds at recovery time (fail-closed)
  const verdict = evaluateSelfHostingBoundary(input.artifact.document, input.boundary);
  if (!verdict.allowed) {
    return {
      kind: 'blocked',
      failure: {
        code: 'SELF_HOSTING_BOUNDARY_DENIED',
        detail: `the self-hosting permission boundary denied the recovery: ${verdict.failure.code} — ${verdict.failure.detail}`,
      },
    };
  }

  // 2. the run is terminally failed (never in-progress, never resurrected)
  if (input.failedRun.state !== 'failed') {
    return {
      kind: 'blocked',
      failure: {
        code: 'SELF_HOSTING_RUN_NOT_FAILED',
        detail: `the run ${input.failedRun.runId} is in state "${input.failedRun.state}" — only a terminal FAILED run is recoverable (a run is never resurrected in place)`,
      },
    };
  }

  // 3. the run belongs to the manifest's exact pinned scope
  if (input.failedRun.workflowId !== input.manifest.workflowId || input.failedRun.versionId !== input.manifest.versionId) {
    return {
      kind: 'blocked',
      failure: {
        code: 'SELF_HOSTING_RUN_SCOPE_MISMATCH',
        detail: `the failed run ${input.failedRun.runId} belongs to ${input.failedRun.workflowId}@${input.failedRun.versionId}, not the manifest's ${input.manifest.workflowId}@${input.manifest.versionId}`,
      },
    };
  }

  // 4. the requested action
  if (input.request.action === 'retry_same_pin') {
    // the CURRENT installed pin must still be the manifest's pin — a
    // drifted pin makes retry-same-pin invalid (an explicit advance or
    // reinstall decision is required; never a silent move)
    const pinStillMatches =
      input.pinFacts.installationId === input.manifest.installationId &&
      input.pinFacts.workflowId === input.manifest.workflowId &&
      input.pinFacts.versionId === input.manifest.versionId &&
      input.pinFacts.versionNumber === input.manifest.versionNumber &&
      input.pinFacts.contentDigest === input.manifest.contentDigest;
    if (!pinStillMatches) {
      return {
        kind: 'blocked',
        failure: {
          code: 'SELF_HOSTING_RECOVERY_ADVANCE_INVALID',
          detail: `the installation pin has moved (the authority reports ${input.pinFacts.workflowId}@${input.pinFacts.versionId}, the manifest pins ${input.manifest.workflowId}@${input.manifest.versionId}) — retry-same-pin is invalid; publish and install an explicit new version (advance_version) instead`,
        },
      };
    }
    return {
      kind: 'retry_same_pin',
      workflowId: input.manifest.workflowId,
      versionId: input.manifest.versionId,
      installationId: input.manifest.installationId,
      failedRunId: input.failedRun.runId,
    };
  }

  // advance_version: an EXPLICIT governed transition to a DIFFERENT
  // version of the SAME workflow (never a redirect in place)
  if (input.request.toVersionId === input.manifest.versionId) {
    return {
      kind: 'blocked',
      failure: {
        code: 'SELF_HOSTING_RECOVERY_ADVANCE_INVALID',
        detail: `the recovery advance targets the manifest's own version ${input.request.toVersionId} — an advance must be a DIFFERENT version (an explicit governed transition)`,
      },
    };
  }
  return {
    kind: 'advance_version',
    workflowId: input.manifest.workflowId,
    fromVersionId: input.manifest.versionId,
    toVersionId: input.request.toVersionId,
    failedRunId: input.failedRun.runId,
  };
}

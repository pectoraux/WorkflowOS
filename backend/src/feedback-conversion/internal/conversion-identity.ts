/**
 * WORK-068 — the deterministic conversion identity (the dedup matching key).
 *
 * PURE sha256 over the canonical identity fields — the same discipline as
 * WORK-067's `deriveSignalIdentity` and WORK-040's `computeProposedWorkItemId`.
 *
 * THE IDENTITY DIMENSIONS (tenant/project scoped — the mandatory boundaries):
 *   tenantId + projectId + logicalFailureKey
 *
 * DELIBERATELY ABSENT: environmentId. The environment participates in the
 * WORK-067 SIGNAL identity (the same logical failure in staging and prod is
 * two signals) and in the assessment's blast radius — but the same logical
 * failure in the same tenant/project is ONE engineering problem, so it
 * converges on ONE governed Work Item (the contract's "same problem,
 * different signals" convergence). Different tenants and different projects
 * NEVER collapse (the mutation-kill proof).
 */
import { createHash } from 'node:crypto';

import type {
  ConversionIdentity,
  ConversionIdentityInput,
} from '../types.js';

/** The canonical field serialization (stable, delimiter-free). */
function canonicalize(input: ConversionIdentityInput): string {
  return JSON.stringify([
    input.tenantId,
    input.projectId,
    input.logicalFailureKey,
  ]);
}

/** Derive the deterministic conversion identity (pure). */
export function deriveConversionIdentity(
  input: ConversionIdentityInput,
): ConversionIdentity {
  const digest = createHash('sha256').update(canonicalize(input), 'utf8').digest('hex');
  return {
    // `SIGWI-` — Signal Work Item: the deterministic proposed Work Item id
    // (the WORK-040 `PLAN-` prefix precedent; the existing
    // UNIQUE(architecture_version_id, work_item_id) constraint fences it).
    conversionKey: `SIGWI-${digest.slice(0, 24)}`,
    identityFingerprint: digest,
  };
}

/**
 * Derive the deterministic decision-record id over (conversionKey,
 * architectureVersionId, signalId, decision): the same logical problem +
 * the same architecture version + the same signal + the same decision is
 * ONE record identity (re-delivery converges on the stored record). The
 * DECISION participates so the append-only log can record the honest
 * decision history of a signal (e.g. 'proposed' at first conversion, then
 * 'deduplicated' once an open equivalent exists) without ever rewriting a
 * stored record.
 *
 * ARCHITECTURE VERSION participates because the authoritative Work Item
 * dedup fence is UNIQUE(architecture_version_id, work_item_id): the SAME
 * logical problem converted under TWO architecture versions legitimately
 * creates TWO governed Work Items, and the decision history must stay
 * version-independent — a record identity without the version dimension
 * would collide across versions and let one version's ConversionResult
 * reference the OTHER version's Work Item through a converged stored
 * record (the PR #107 architect-review blocker). The version dimension is
 * proven by mutation-kill: removing it from this canonicalization makes
 * the cross-version independence invariant test FAIL.
 */
export function deriveConversionRecordId(
  conversionKey: string,
  architectureVersionId: string,
  signalId: string,
  decision: string,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([conversionKey, architectureVersionId, signalId, decision]),
      'utf8',
    )
    .digest('hex');
  return `SIGWIR-${digest.slice(0, 24)}`;
}

/**
 * Derive the deterministic proposal title from the logical failure key (the
 * planner's title derivation discipline — deterministic, never fabricated).
 */
export function deriveProposalTitle(logicalFailureKey: string): string {
  const trimmed = logicalFailureKey.trim();
  if (trimmed.length === 0) return 'Untitled engineering-signal conversion';
  return `Resolve: ${trimmed}`.charAt(0).toUpperCase() + `Resolve: ${trimmed}`.slice(1);
}

/** The deterministic objective (the planner's honest-provenance framing). */
export function deriveProposalObjective(
  logicalFailureKey: string,
  signalId: string,
  severity: 'critical' | 'high' | 'medium' | 'low',
  occurrenceCount: number,
): string {
  return [
    `Resolve the engineering problem identified by logical failure key '${logicalFailureKey}'`,
    `(latest severity ${severity}, ${occurrenceCount} recorded occurrence(s)).`,
    `(conversion recommendation — provenance: Engineering Signal ${signalId} via WORK-067; advisory, not confirmed truth)`,
  ].join(' ');
}

/**
 * The deterministic architecture-impact declaration for the conversion (the
 * WORK-051 governed declaration, set at creation through the existing
 * intake): critical/high signals declare 'high' (the strictest checkpoint
 * frequency), medium declares 'medium', low declares 'low'. Monotonic-safe:
 * this is the initial declaration, never a weakening.
 */
export function deriveArchitectureImpact(
  severity: 'critical' | 'high' | 'medium' | 'low',
): 'low' | 'medium' | 'high' {
  if (severity === 'critical' || severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

/**
 * WORK-068 — the conversion-relative priority.
 *
 * INVARIANT 5 (the no-second-planning-authority rule): this is RELATIVE
 * conversion priority for PROPOSED work — a discrete, explainable ranking
 * attached to the proposal. It is NEVER a backlog ordering engine, NEVER a
 * scheduling input, and NEVER a replacement for the WORK-040 continuous
 * development planner (which remains the ONE planning authority this
 * conversion FEEDS).
 *
 * THE DETERMINISTIC RANK RULES (documented — never an opaque score):
 *   base rank from the latest severity interpretation:
 *     critical → P0, high → P1, medium → P2, low → P3;
 *   escalation (at most ONE level, never past P0) when the recorded
 *   evidence shows breadth:
 *     ≥ 5 occurrences (repeated re-delivery/recurrence), OR
 *     ≥ 3 distinct sources, OR
 *     the assessment spans ≥ 2 environments (multi-environment
 *     convergence recorded on the conversion's contributing signals).
 */
import type {
  ConversionAssessment,
  ConversionFactor,
  ConversionPriority,
  ConversionPriorityRank,
} from '../types.js';

const SEVERITY_BASE_RANK: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const RANK_BY_NUMBER: readonly ConversionPriorityRank[] = ['P0', 'P1', 'P2', 'P3'];

/** The severity ordering used for the RELATIVE statement (explanatory only). */
const SEVERITY_ORDER: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Derive the deterministic conversion-relative priority.
 *
 * `convergenceEnvironmentCount` is the number of DISTINCT environments
 * recorded across the conversion's contributing signals (supplied by the
 * orchestrator from the authoritative Work Item's provenance record, or 1
 * for a fresh conversion) — the multi-environment breadth evidence.
 */
export function deriveConversionPriority(
  assessment: ConversionAssessment,
  convergenceEnvironmentCount: number,
): ConversionPriority {
  const factors: ConversionFactor[] = [];

  const baseNumber = SEVERITY_BASE_RANK[assessment.latestSeverity];
  factors.push({
    kind: 'signal-severity',
    detail: `base rank ${RANK_BY_NUMBER[baseNumber]} — the latest recorded severity '${assessment.latestSeverity}' maps deterministically (critical→P0, high→P1, medium→P2, low→P3)`,
  });

  let escalated = false;
  if (assessment.occurrenceCount >= 5) {
    factors.push({
      kind: 'recurrence',
      detail: `${assessment.occurrenceCount} recorded occurrences (≥ 5) — the problem recurs; the proposal escalates one rank (never past P0)`,
    });
    escalated = true;
  }
  if (assessment.sources.length >= 3) {
    factors.push({
      kind: 'blast-radius-sources',
      detail: `${assessment.sources.length} distinct sources (≥ 3) — the problem is observed across heterogeneous sources; the proposal escalates one rank (never past P0)`,
    });
    escalated = true;
  }
  if (convergenceEnvironmentCount >= 2) {
    factors.push({
      kind: 'multi-environment-convergence',
      detail: `${convergenceEnvironmentCount} distinct environments recorded across the conversion's contributing signals (≥ 2) — the logical problem spans environments; the proposal escalates one rank (never past P0)`,
    });
    escalated = true;
  }

  const rankNumber = escalated ? Math.max(0, baseNumber - 1) : baseNumber;
  const rank = RANK_BY_NUMBER[rankNumber]!;

  // The RELATIVE statement (explanatory only — never a backlog reorder).
  const open = assessment.backlogContext.openItemCount;
  const openSeverities = assessment.backlogContext.openConversionSeverities;
  let ahead = 0;
  for (const [severity, count] of Object.entries(openSeverities)) {
    const order = SEVERITY_ORDER[severity as 'critical' | 'high' | 'medium' | 'low'];
    if (order !== undefined && order > SEVERITY_ORDER[assessment.latestSeverity]) {
      ahead += count;
    }
  }
  const backlogRelation =
    open === 0
      ? 'the target version currently records no open Work Items — the proposal would be the first (relative statement only; the WORK-040 planner owns all backlog ordering)'
      : `by conversion severity ordering the proposal ranks ahead of ${ahead} of ${open} open Work Item(s) recorded in the target version (relative statement only; the WORK-040 planner owns all backlog ordering)`;

  const rationale = [
    `conversion-relative priority ${rank}`,
    escalated
      ? `(base ${RANK_BY_NUMBER[baseNumber]} escalated one level by breadth evidence — the escalation rules are documented and deterministic)`
      : '(no escalation — the recorded evidence shows no breadth beyond the base severity)',
    `— an explainable ranking attached to the proposal, never a planning-engine output.`,
  ].join(' ');

  return { rank, factors, rationale, backlogRelation };
}

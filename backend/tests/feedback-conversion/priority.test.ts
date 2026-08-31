import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the conversion-relative priority proofs (invariant 5).
 *
 * The priority is RELATIVE CONVERSION PRIORITY for proposed work: discrete,
 * explainable, deterministic. It is NEVER a backlog ordering engine, NEVER
 * a scheduling input, NEVER a replacement for the WORK-040 planner.
 */
import { deriveConversionPriority } from '../../src/feedback-conversion/internal/index.js';
import { assessSignal } from '../../src/feedback-conversion/internal/index.js';
import { signalFixture } from './helpers.js';

function assess(overrides: Parameters<typeof signalFixture>[0] = {}) {
  return assessSignal(signalFixture(overrides), {
    openItemCount: 3,
    completedItemCount: 1,
    openConversionSeverities: { high: 1, low: 1 },
  });
}

describe('WORK-068 — the conversion-relative priority', () => {
  it('the base rank maps deterministically from the latest severity (critical→P0, high→P1, medium→P2, low→P3)', () => {
    expect(deriveConversionPriority(assess({ latestSeverity: 'critical', occurrences: [{ observedAt: '2026-09-01T00:00:00Z', severity: 'critical' }] }), 1).rank).toBe('P0');
    expect(deriveConversionPriority(assess({ latestSeverity: 'high' }), 1).rank).toBe('P1');
    expect(deriveConversionPriority(assess({ latestSeverity: 'medium' }), 1).rank).toBe('P2');
    expect(deriveConversionPriority(assess({ latestSeverity: 'low' }), 1).rank).toBe('P3');
  });

  it('escalates ONE level for recurrence breadth (≥ 5 occurrences), never past P0', () => {
    const many = assess({
      latestSeverity: 'medium',
      occurrences: [
        { observedAt: '2026-09-01T00:00:00Z', severity: 'medium' },
        { observedAt: '2026-09-01T01:00:00Z', severity: 'medium' },
        { observedAt: '2026-09-01T02:00:00Z', severity: 'medium' },
        { observedAt: '2026-09-01T03:00:00Z', severity: 'medium' },
        { observedAt: '2026-09-01T04:00:00Z', severity: 'medium' },
      ],
    });
    expect(deriveConversionPriority(many, 1).rank).toBe('P1');
    // Never past P0: a critical with breadth stays P0.
    const criticalMany = assess({
      latestSeverity: 'critical',
      occurrences: [
        { observedAt: '2026-09-01T00:00:00Z', severity: 'critical' },
        { observedAt: '2026-09-01T01:00:00Z', severity: 'critical' },
        { observedAt: '2026-09-01T02:00:00Z', severity: 'critical' },
        { observedAt: '2026-09-01T03:00:00Z', severity: 'critical' },
        { observedAt: '2026-09-01T04:00:00Z', severity: 'critical' },
      ],
    });
    expect(deriveConversionPriority(criticalMany, 1).rank).toBe('P0');
  });

  it('escalates ONE level for source breadth (≥ 3 distinct sources)', () => {
    const three = assess({ latestSeverity: 'low', sources: ['validation', 'ci', 'runtime'] });
    expect(deriveConversionPriority(three, 1).rank).toBe('P2'); // P3 base escalated one level.
  });

  it('escalates ONE level for multi-environment convergence (≥ 2 recorded environments)', () => {
    const priority = deriveConversionPriority(assess({ latestSeverity: 'low' }), 2);
    expect(priority.rank).toBe('P2'); // P3 base escalated one level.
  });

  it('NO escalation without breadth (single occurrence, single source, single environment)', () => {
    const single = assess({
      latestSeverity: 'high',
      occurrences: [{ observedAt: '2026-09-01T00:00:00Z', severity: 'high' }],
      sources: ['validation'],
    });
    expect(deriveConversionPriority(single, 1).rank).toBe('P1');
  });

  it('the backlog relation is RELATIVE and explanatory ONLY — it never reorders the backlog and says so', () => {
    const priority = deriveConversionPriority(assess({ latestSeverity: 'critical' }), 1);
    // 3 open items: high + low recorded severities; a critical ranks ahead of both.
    expect(priority.backlogRelation).toContain('ranks ahead of 2 of 3 open Work Item(s)');
    expect(priority.backlogRelation).toContain('the WORK-040 planner owns all backlog ordering');
  });

  it('the backlog relation for an empty backlog is the honest first-proposal statement', () => {
    const empty = assessSignal(signalFixture(), { openItemCount: 0, completedItemCount: 0, openConversionSeverities: {} });
    const priority = deriveConversionPriority(empty, 1);
    expect(priority.backlogRelation).toContain('no open Work Items');
  });

  it('a CRITICAL proposal ranks AHEAD of lower-severity equivalents — explainably, without a second planning authority', () => {
    const critical = deriveConversionPriority(assess({ latestSeverity: 'critical' }), 1);
    const low = deriveConversionPriority(assess({ latestSeverity: 'low' }), 1);
    expect(critical.rank < low.rank).toBe(true); // P0 < P3 in rank ordering.
    expect(critical.rationale).toContain('never a planning-engine output');
  });

  it('every factor is one of the closed vocabulary kinds and the escalation rules are cited in the details', () => {
    const priority = deriveConversionPriority(
      assess({
        sources: ['validation', 'ci', 'runtime'],
        occurrences: [
          { observedAt: '2026-09-01T00:00:00Z', severity: 'medium' },
          { observedAt: '2026-09-01T01:00:00Z', severity: 'medium' },
          { observedAt: '2026-09-01T02:00:00Z', severity: 'medium' },
          { observedAt: '2026-09-01T03:00:00Z', severity: 'medium' },
          { observedAt: '2026-09-01T04:00:00Z', severity: 'medium' },
        ],
      }),
      3,
    );
    const kinds = priority.factors.map((f) => f.kind);
    expect(kinds).toContain('signal-severity');
    expect(kinds).toContain('recurrence');
    expect(kinds).toContain('blast-radius-sources');
    expect(kinds).toContain('multi-environment-convergence');
    const details = priority.factors.map((f) => f.detail).join(' ');
    expect(details).toContain('escalates one rank');
  });
});

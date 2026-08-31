import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the deterministic assessment proofs.
 *
 * The assessment INTERPRETS recorded evidence (the WORK-067 signal record +
 * the backlog read through the authority) — it never invents evidence.
 * Every factor cites its source; the reasoning is structured and reviewable.
 */
import { assessSignal, deriveBacklogContext, deriveRecurrenceSpan } from '../../src/feedback-conversion/internal/index.js';
import { signalFixture } from './helpers.js';

describe('WORK-068 — the deterministic conversion assessment', () => {
  it('preserves the signal identity fields EXACTLY (the WORK-067 record reference — never redefined)', () => {
    const signal = signalFixture();
    const assessment = assessSignal(signal, { openItemCount: 0, completedItemCount: 0, openConversionSeverities: {} });
    expect(assessment.signalId).toBe(signal.signalId);
    expect(assessment.signalFingerprint).toBe(signal.identityFingerprint);
    expect(assessment.tenantId).toBe(signal.tenantId);
    expect(assessment.projectId).toBe(signal.projectId);
  });

  it('derives the severity interpretation deterministically (the documented mapping)', () => {
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
      const assessment = assessSignal(
        signalFixture({ latestSeverity: severity }),
        { openItemCount: 0, completedItemCount: 0, openConversionSeverities: {} },
      );
      expect(assessment.severityInterpretation).toContain(severity);
      expect(assessment.latestSeverity).toBe(severity);
    }
  });

  it('counts the occurrences and derives the recurrence span from the RECORDED window (never extrapolated)', () => {
    const assessment = assessSignal(
      signalFixture({
        occurrences: [
          { observedAt: '2026-09-01T00:00:00Z', severity: 'low' },
          { observedAt: '2026-09-01T06:00:00Z', severity: 'low' },
          { observedAt: '2026-09-02T00:00:00Z', severity: 'low' },
        ],
        firstObservedAt: '2026-09-01T00:00:00Z',
        lastObservedAt: '2026-09-02T00:00:00Z',
      }),
      { openItemCount: 0, completedItemCount: 0, openConversionSeverities: {} },
    );
    expect(assessment.occurrenceCount).toBe(3);
    expect(assessment.recurrenceSpan).toBe('P1DT00H00M00S');
  });

  it('derives the recurrence span as PT0S for a single occurrence (no invented breadth)', () => {
    const assessment = assessSignal(
      signalFixture({
        occurrences: [{ observedAt: '2026-09-01T00:00:00Z', severity: 'high' }],
        firstObservedAt: '2026-09-01T00:00:00Z',
        lastObservedAt: '2026-09-01T00:00:00Z',
      }),
      { openItemCount: 0, completedItemCount: 0, openConversionSeverities: {} },
    );
    expect(assessment.recurrenceSpan).toBe('PT0S');
  });

  it('records the backlog context VERBATIM (the read-through-the-authority evidence)', () => {
    const backlog = { openItemCount: 4, completedItemCount: 2, openConversionSeverities: { high: 1 } };
    const assessment = assessSignal(signalFixture(), backlog);
    expect(assessment.backlogContext).toEqual(backlog);
  });

  it('every factor cites recorded evidence — no release/deployment/GitHub/provider/business evidence is ever cited', () => {
    const assessment = assessSignal(signalFixture(), { openItemCount: 2, completedItemCount: 1, openConversionSeverities: {} });
    const allDetails = assessment.factors.map((f) => f.detail).join(' ');
    for (const forbidden of ['release', 'deployment', 'commit', 'github', 'provider', 'business outcome']) {
      expect(allDetails.toLowerCase()).not.toContain(forbidden);
    }
    // The factor kinds are the closed vocabulary.
    for (const f of assessment.factors) {
      expect([
        'signal-severity', 'recurrence', 'blast-radius-environments',
        'blast-radius-sources', 'multi-environment-convergence', 'backlog-context',
      ]).toContain(f.kind);
    }
  });

  it('the reasoning is structured and reviewable (scope + severity + recurrence + blast radius + backlog + the no-invention declaration)', () => {
    const assessment = assessSignal(signalFixture(), { openItemCount: 2, completedItemCount: 0, openConversionSeverities: {} });
    const r = assessment.reasoning;
    expect(r).toContain(signalFixture().signalId);
    expect(r).toContain('severity —');
    expect(r).toContain('recurrence —');
    expect(r).toContain('blast radius —');
    expect(r).toContain('backlog —');
    expect(r).toContain('nothing is inferred');
  });

  it('deriveRecurrenceSpan handles the inverted window defensively (PT0S — never negative, never fabricated)', () => {
    expect(deriveRecurrenceSpan('2026-09-02T00:00:00Z', '2026-09-01T00:00:00Z')).toBe('PT0S');
    expect(deriveRecurrenceSpan('not-a-date', '2026-09-01T00:00:00Z')).toBe('PT0S');
  });

  it('deriveBacklogContext reads ONLY the authoritative item records (open/completed + prior conversion severities)', () => {
    const context = deriveBacklogContext([
      { completed: false, metadata: {} },
      { completed: true, metadata: {} },
      {
        completed: false,
        metadata: { feedbackConversion: { assessment: { latestSeverity: 'critical' } } },
      },
      {
        completed: false,
        metadata: { feedbackConversion: { assessment: { latestSeverity: 'critical' } } },
      },
    ]);
    expect(context.openItemCount).toBe(3);
    expect(context.completedItemCount).toBe(1);
    expect(context.openConversionSeverities).toEqual({ critical: 2 });
  });
});

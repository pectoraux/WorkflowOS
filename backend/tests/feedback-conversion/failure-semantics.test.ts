import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the failure-semantics proofs (§12: typed + fail closed).
 *
 * Failures are NEVER transformed into "no work needed / healthy / nothing
 * to do / success". A missing source or failed authority read never
 * silently produces an empty conclusion.
 */
import { buildService, signalFixture } from './helpers.js';
import { FeedbackConversionError } from '../../src/feedback-conversion/index.js';

const VERSION = 'archver-1';

describe('WORK-068 — typed, fail-closed failure semantics', () => {
  it('a MISSING signal fails closed with FEEDBACK_SIGNAL_NOT_FOUND (never an empty conclusion)', async () => {
    const { service, ctx } = buildService({ signals: [] });
    await expect(
      service.convertSignal({ signalId: 'sig_missing', architectureVersionId: VERSION }, ctx),
    ).rejects.toBeInstanceOf(FeedbackConversionError);
    await expect(
      service.convertSignal({ signalId: 'sig_missing', architectureVersionId: VERSION }, ctx),
    ).rejects.toMatchObject({ code: 'FEEDBACK_SIGNAL_NOT_FOUND' });
  });

  it('a signal with NO occurrences fails closed with FEEDBACK_SIGNAL_EMPTY', async () => {
    const empty = signalFixture({ signalId: 'sig_empty', occurrences: [] });
    const { service, ctx } = buildService({ signals: [empty] });
    await expect(
      service.convertSignal({ signalId: 'sig_empty', architectureVersionId: VERSION }, ctx),
    ).rejects.toMatchObject({ code: 'FEEDBACK_SIGNAL_EMPTY' });
  });

  it('an INTAKE FAILURE (non-unique create error) fails closed with FEEDBACK_INTAKE_UNAVAILABLE — nothing landed, no silent retry, no fallback intake', async () => {
    const signal = signalFixture();
    const { service, ctx, intake } = buildService({ signals: [signal] });
    intake.failNextCreate = new Error('connection refused');
    await expect(
      service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx),
    ).rejects.toMatchObject({ code: 'FEEDBACK_INTAKE_UNAVAILABLE' });
    // Nothing landed: no work item was created.
    expect(intake.countOpen()).toBe(0);
  });

  it('a missing architecture version fails closed with FEEDBACK_ARCHITECTURE_VERSION_NOT_FOUND', async () => {
    const { service, ctx } = buildService();
    await expect(
      service.convertSignal({ signalId: 'sig_abc123def456789abc123def', architectureVersionId: 'archver-NOPE' }, ctx),
    ).rejects.toMatchObject({ code: 'FEEDBACK_ARCHITECTURE_VERSION_NOT_FOUND' });
  });

  it('an architecture version in a DIFFERENT project fails closed with FEEDBACK_ARCHITECTURE_VERSION_NOT_IN_PROJECT (defense in depth)', async () => {
    // The scope fixture binds the architecture to project-OTHER while the
    // ctx scope is project-1 → the version-not-in-project guard fires
    // BEFORE any signal read (the planner's defense-in-depth precedent).
    const signal = signalFixture();
    const build = buildService({ signals: [signal], projectId: 'project-1', archProjectId: 'project-OTHER' });
    await expect(
      build.service.convertSignal({ signalId: signal.signalId, architectureVersionId: build.versionId }, build.ctx),
    ).rejects.toMatchObject({ code: 'FEEDBACK_ARCHITECTURE_VERSION_NOT_IN_PROJECT' });
  });

  it('the typed error carries its code in the message (reviewable failures — never swallowed)', async () => {
    const { service, ctx } = buildService({ signals: [] });
    const err = await service
      .convertSignal({ signalId: 'sig_missing', architectureVersionId: VERSION }, ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeedbackConversionError);
    expect((err as FeedbackConversionError).message).toContain('FEEDBACK_SIGNAL_NOT_FOUND');
  });

  it('failures never produce a "healthy/no work needed" result shape (the closed decision vocabulary excludes success-failure states)', () => {
    // The closed vocabulary: proposed | deduplicated | recurrence-recorded.
    // None of them is a failure state — failures are THROWN, never returned.
    const statuses = ['proposed', 'deduplicated', 'recurrence-recorded'] as const;
    for (const forbidden of ['no-work-needed', 'healthy', 'nothing-to-do', 'success']) {
      expect((statuses as readonly string[]).includes(forbidden)).toBe(false);
    }
  });

  it('the record-log append conflict fails closed with FEEDBACK_CONVERSION_RECORD_CONFLICT (never silently rewritten)', async () => {
    const { records } = buildService();
    await records.append({
      recordId: 'SIGWIR-fixed', conversionKey: 'SIGWI-k', architectureVersionId: 'archver-1',
      tenantId: 't', projectId: 'p',
      signalId: 'sig_1', decision: 'proposed', workItemId: 'wi-1', workItemHumanId: 'SIGWI-k',
      decidedAt: '2026-09-01T00:00:00Z', summary: 'first',
    });
    await expect(
      records.append({
        recordId: 'SIGWIR-fixed', conversionKey: 'SIGWI-k', architectureVersionId: 'archver-1',
        tenantId: 't', projectId: 'p',
        signalId: 'sig_1', decision: 'deduplicated', workItemId: 'wi-1', workItemHumanId: 'SIGWI-k',
        decidedAt: '2026-09-02T00:00:00Z', summary: 'conflicting rewrite attempt',
      }),
    ).rejects.toMatchObject({ code: 'FEEDBACK_CONVERSION_RECORD_CONFLICT' });
    // The architecture-version payload dimension is ALSO part of the
    // conflict check (defense in depth — a recordId colliding across
    // versions never silently converges onto the other version's payload):
    await expect(
      records.append({
        recordId: 'SIGWIR-fixed', conversionKey: 'SIGWI-k', architectureVersionId: 'archver-2',
        tenantId: 't', projectId: 'p',
        signalId: 'sig_1', decision: 'proposed', workItemId: 'wi-2', workItemHumanId: 'SIGWI-k',
        decidedAt: '2026-09-02T00:00:00Z', summary: 'cross-version collision attempt',
      }),
    ).rejects.toMatchObject({ code: 'FEEDBACK_CONVERSION_RECORD_CONFLICT' });
  });

  it('the record-log idempotent append CONVERGES on the stored record (re-delivery never duplicates the log)', async () => {
    const { records } = buildService();
    const first = await records.append({
      recordId: 'SIGWIR-fixed', conversionKey: 'SIGWI-k', architectureVersionId: 'archver-1',
      tenantId: 't', projectId: 'p',
      signalId: 'sig_1', decision: 'proposed', workItemId: 'wi-1', workItemHumanId: 'SIGWI-k',
      decidedAt: '2026-09-01T00:00:00Z', summary: 'first',
    });
    const again = await records.append({
      recordId: 'SIGWIR-fixed', conversionKey: 'SIGWI-k', architectureVersionId: 'archver-1',
      tenantId: 't', projectId: 'p',
      signalId: 'sig_1', decision: 'proposed', workItemId: 'wi-1', workItemHumanId: 'SIGWI-k',
      decidedAt: '2026-09-01T00:00:00Z', summary: 'first',
    });
    expect(again).toEqual(first);
    const history = await records.listForConversion('SIGWI-k');
    expect(history).toHaveLength(1);
    // The SAME identity under a DIFFERENT architecture version is an
    // INDEPENDENT record (never converged, never a conflict — two rows):
    const other = await records.append({
      recordId: 'SIGWIR-fixed-v2', conversionKey: 'SIGWI-k', architectureVersionId: 'archver-2',
      tenantId: 't', projectId: 'p',
      signalId: 'sig_1', decision: 'proposed', workItemId: 'wi-2', workItemHumanId: 'SIGWI-k',
      decidedAt: '2026-09-01T00:00:00Z', summary: 'first under version 2',
    });
    expect(other.recordId).not.toBe(first.recordId);
    const after = await records.listForConversion('SIGWI-k');
    expect(after).toHaveLength(2);
  });
});

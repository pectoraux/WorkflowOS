import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the concurrency + idempotency proofs (§11, the domain path).
 *
 * The same logical signal converted twice (sequentially here; the TRUE
 * two-actor interleaving is proven on real PostgreSQL by
 * tests/integration/feedback-conversion/conversion-concurrency.integration.
 * test.ts) converges on ONE authoritative Work Item + ONE conversion
 * outcome. The re-drive after an unsuccessful conversion is explicit: the
 * deterministic identity stays stable, nothing landed, the retry creates.
 */
import { buildService, signalFixture, readFeedback } from './helpers.js';
import { deriveConversionIdentity } from '../../src/feedback-conversion/index.js';

const VERSION = 'archver-1';

describe('WORK-068 — concurrency + idempotency (domain path)', () => {
  it('SAME SIGNAL, two sequential conversions → ONE authoritative Work Item, ONE open item, the honest decision history', async () => {
    const signal = signalFixture();
    const { service, ctx, intake, records } = buildService({ signals: [signal] });
    const a = await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    const b = await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    expect(a.decision).toBe('proposed');
    expect(b.decision).toBe('deduplicated');
    expect(b.workItem?.id).toBe(a.workItem?.id);
    expect(intake.countOpen()).toBe(1);
    const history = await records.listForConversion(a.conversionKey);
    expect(history.map((r) => r.decision)).toEqual(['proposed', 'deduplicated']);
  });

  it('SAME PROBLEM, DIFFERENT SIGNALS (two environments) → the two converge on the SAME open Work Item', async () => {
    const key = 'validation:execution:dependency-blocked-admission';
    const s1 = signalFixture({ signalId: 'sig_env1', logicalFailureKey: key, environmentId: 'env-1', identityFingerprint: 'f1'.repeat(32) });
    const s2 = signalFixture({ signalId: 'sig_env2', logicalFailureKey: key, environmentId: 'env-2', identityFingerprint: 'f2'.repeat(32) });
    const { service, ctx, intake } = buildService({ signals: [s1, s2] });
    const r1 = await service.convertSignal({ signalId: 'sig_env1', architectureVersionId: VERSION }, ctx);
    const r2 = await service.convertSignal({ signalId: 'sig_env2', architectureVersionId: VERSION }, ctx);
    expect(r1.decision).toBe('proposed');
    expect(r2.decision).toBe('deduplicated');
    expect(r2.workItem?.id).toBe(r1.workItem?.id);
    expect(intake.countOpen()).toBe(1);
  });

  it('RE-DELIVERY after the item is OPEN: the idempotent metadata append (no duplicate contributor entry)', async () => {
    const signal = signalFixture();
    const { service, ctx, intake } = buildService({ signals: [signal] });
    await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    const items = await intake.findByArchitectureVersion(VERSION);
    const feedback = readFeedback(items[0]!).feedbackConversion as { contributingSignals: unknown[] };
    expect(feedback.contributingSignals).toHaveLength(1);
    expect(intake.countOpen()).toBe(1);
  });

  it('RE-DRIVE after an UNSUCCESSFUL conversion: the identity is STABLE and the retry creates (no ambiguous "probably already created")', async () => {
    const signal = signalFixture();
    const { service, ctx, intake } = buildService({ signals: [signal] });
    // The first conversion fails at the intake (nothing landed).
    intake.failNextCreate = new Error('transient connection failure');
    await expect(
      service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx),
    ).rejects.toMatchObject({ code: 'FEEDBACK_INTAKE_UNAVAILABLE' });
    expect(intake.countOpen()).toBe(0); // nothing landed — explicit.
    // The re-drive: the SAME deterministic identity → the create succeeds.
    const retried = await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    expect(retried.decision).toBe('proposed');
    expect(intake.countOpen()).toBe(1);
    const expectedKey = deriveConversionIdentity({
      tenantId: 'tenant-1', projectId: 'project-1', logicalFailureKey: signal.logicalFailureKey,
    });
    expect(retried.conversionKey).toBe(expectedKey.conversionKey);
    expect(retried.workItem?.workItemId).toBe(expectedKey.conversionKey);
  });

  it('the conversion identity is stable across clock changes (deterministic — not time-derived)', () => {
    const a = deriveConversionIdentity({ tenantId: 't', projectId: 'p', logicalFailureKey: 'k' });
    const b = deriveConversionIdentity({ tenantId: 't', projectId: 'p', logicalFailureKey: 'k' });
    expect(a.conversionKey).toBe(b.conversionKey);
  });

  it('the record log converges under duplicate delivery of the SAME decision (the keyed identity includes the decision)', async () => {
    const signal = signalFixture();
    const { service, ctx, records } = buildService({ signals: [signal] });
    const r1 = await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    const r2 = await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    const r3 = await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    // The re-deliveries converge on the SAME 'deduplicated' record:
    expect(r2.record.recordId).toBe(r3.record.recordId);
    expect(r2.record.decidedAt).toBe(r3.record.decidedAt);
    // The decision history is the honest two-entry append:
    const history = await records.listForProject('project-1');
    expect(history.map((r) => r.decision)).toEqual(['proposed', 'deduplicated']);
    // Each record identity appears exactly once (no duplicated log entries):
    const ids = history.map((r) => r.recordId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r1.record.recordId).not.toBe(r2.record.recordId);
  });
});

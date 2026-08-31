import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the provenance proofs (invariant 3).
 *
 * Every proposed Work Item preserves provenance to its originating
 * Engineering Signal(s). The chain is reconstructable end to end:
 *   observation → engineering signal → assessment → conversion decision →
 *   the EXISTING Work Item. Never a hash alone; never inferred from
 *   timestamps, titles, commits, URLs.
 */
import { buildService, signalFixture, readFeedback } from './helpers.js';
import type { ContributingSignal } from '../../src/feedback-conversion/index.js';

const VERSION = 'archver-1';

describe('WORK-068 — provenance preservation', () => {
  it('the created Work Item carries metadata.feedbackConversion with the FULL signal identity (id + fingerprint, never a hash alone)', async () => {
    const signal = signalFixture();
    const { service, ctx, intake } = buildService({ signals: [signal] });
    const result = await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    const items = await intake.findByArchitectureVersion(VERSION);
    const feedback = readFeedback(items[0]!).feedbackConversion as {
      conversionKey: string;
      identityFingerprint: string;
      tenantId: string;
      projectId: string;
      logicalFailureKey: string;
      contributingSignals: ContributingSignal[];
      assessment: { reasoning: string };
      provenanceNote: string;
    };
    // The signal reference: preserved EXACTLY as WORK-067 defines it.
    expect(feedback.contributingSignals[0]!.signalId).toBe(signal.signalId);
    expect(feedback.contributingSignals[0]!.identityFingerprint).toBe(signal.identityFingerprint);
    expect(feedback.tenantId).toBe(signal.tenantId);
    expect(feedback.projectId).toBe(signal.projectId);
    expect(feedback.logicalFailureKey).toBe(signal.logicalFailureKey);
    // The non-hash content is preserved (the full evidence, not a digest).
    expect(feedback.assessment.reasoning).toContain(signal.signalId);
    expect(result.signal.signalId).toBe(signal.signalId);
  });

  it('the chain is RECONSTRUCTABLE: record → signal → assessment → decision → the authoritative Work Item', async () => {
    const signal = signalFixture();
    const { service, ctx, records, intake } = buildService({ signals: [signal] });
    const result = await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    // 1. The decision record references the signal AND the work item.
    expect(result.record.signalId).toBe(signal.signalId);
    expect(result.record.workItemHumanId).toBe(result.conversionKey);
    // 2. The record is retrievable from the log by the conversion key.
    const history = await records.listForConversion(result.conversionKey);
    expect(history.some((r) => r.signalId === signal.signalId && r.decision === 'proposed')).toBe(true);
    // 3. The authoritative Work Item is retrievable through the authority.
    const items = await intake.findByArchitectureVersion(VERSION);
    expect(items[0]!.workItemId).toBe(result.conversionKey);
    // 4. The Work Item's metadata carries the SAME signal reference.
    const feedback = readFeedback(items[0]!).feedbackConversion as { contributingSignals: ContributingSignal[] };
    expect(feedback.contributingSignals[0]!.signalId).toBe(signal.signalId);
  });

  it('MULTI-SIGNAL provenance: the authoritative record preserves WHICH signals contributed and HOW', async () => {
    const key = 'validation:execution:dependency-blocked-admission';
    const signalA = signalFixture({ signalId: 'sig_A', environmentId: 'env-prod-1', logicalFailureKey: key, identityFingerprint: 'a'.repeat(64) });
    const signalB = signalFixture({ signalId: 'sig_B', environmentId: 'env-staging-1', logicalFailureKey: key, identityFingerprint: 'b'.repeat(64) });
    const { service, ctx, intake } = buildService({ signals: [signalA, signalB] });
    await service.convertSignal({ signalId: 'sig_A', architectureVersionId: VERSION }, ctx);
    await service.convertSignal({ signalId: 'sig_B', architectureVersionId: VERSION }, ctx);
    const items = await intake.findByArchitectureVersion(VERSION);
    const feedback = readFeedback(items[0]!).feedbackConversion as { contributingSignals: ContributingSignal[] };
    expect(feedback.contributingSignals).toHaveLength(2);
    const byId = new Map(feedback.contributingSignals.map((cs) => [cs.signalId, cs]));
    expect(byId.get('sig_A')!.contributedAs).toBe('proposed');
    expect(byId.get('sig_B')!.contributedAs).toBe('deduplicated');
    expect(byId.get('sig_B')!.environmentId).toBe('env-staging-1');
  });

  it('the contributing-signals record is APPEND-ONLY (re-delivery never rewrites the recorded provenance)', async () => {
    const signal = signalFixture();
    const { service, ctx, intake } = buildService({ signals: [signal] });
    await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    const afterFirst = await intake.findByArchitectureVersion(VERSION);
    const firstSnapshot = structuredClone(readFeedback(afterFirst[0]!).feedbackConversion);
    await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    const afterSecond = await intake.findByArchitectureVersion(VERSION);
    const second = readFeedback(afterSecond[0]!).feedbackConversion as { contributingSignals: ContributingSignal[] };
    // The idempotent re-delivery: same single contributor, same recorded decidedAt.
    expect(second.contributingSignals).toEqual(
      (firstSnapshot as { contributingSignals: ContributingSignal[] }).contributingSignals,
    );
  });

  it('the provenance note declares the ADVISORY origin honestly (never confirmed truth)', async () => {
    const signal = signalFixture();
    const { service, ctx, intake } = buildService({ signals: [signal] });
    await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    const items = await intake.findByArchitectureVersion(VERSION);
    const feedback = readFeedback(items[0]!).feedbackConversion as { provenanceNote: string };
    expect(feedback.provenanceNote).toContain('ADVISORY');
    expect(feedback.provenanceNote).toContain('never confirmed truth');
    expect(feedback.provenanceNote).toContain('full governance lifecycle');
  });

  it('NO provenance is ever inferred from titles, timestamps, commits, or URLs (the metadata carries only signal-derived evidence)', async () => {
    const signal = signalFixture();
    const { service, ctx, intake } = buildService({ signals: [signal] });
    await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    const items = await intake.findByArchitectureVersion(VERSION);
    const raw = JSON.stringify(readFeedback(items[0]!).feedbackConversion);
    // The ONLY external reference forms are the signal's own recorded fields.
    expect(raw).toContain(signal.signalId);
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw).not.toMatch(/commit [0-9a-f]{7,}/i);
  });

  it('a FREE-FLOATING proposal is impossible: the intake create always embeds the provenance payload (structural)', async () => {
    const signal = signalFixture();
    const { service, ctx, intake } = buildService({ signals: [signal] });
    await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    const items = await intake.findByArchitectureVersion(VERSION);
    for (const item of items) {
      const feedback = readFeedback(item).feedbackConversion;
      expect(feedback).toBeDefined();
      expect((feedback as { contributingSignals: unknown[] }).contributingSignals.length).toBeGreaterThan(0);
    }
  });
});

import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the cross-architecture-version decision-record independence
 * (the PR #107 architect-review BLOCKER 1 regression).
 *
 * The authoritative Work Item dedup fence is UNIQUE(architecture_version_id,
 * work_item_id): the SAME logical failure key converted under TWO
 * architecture versions legitimately creates TWO governed Work Items. The
 * decision-record identity must therefore be scoped by the architecture
 * version — otherwise the exact defect the architect demonstrated:
 *
 * ```text
 * Signal S → Architecture Version A → record R
 * Signal S → Architecture Version B → Work Item B created
 *                                       ↘ same recordId R
 *                                         → the log returns Version A's record
 * ```
 *
 * …lets the returned ConversionResult reference Work Item B while its
 * decision record still references Work Item A. This suite proves that can
 * never happen: two versions → two Work Items + two INDEPENDENT decision
 * records, each referencing ITS OWN version's Work Item — while re-delivery
 * WITHIN each version stays idempotent (one Work Item, converging log).
 */
import { buildMultiVersionScenario, signalFixture } from './helpers.js';

describe('WORK-068 — the cross-architecture-version decision-record independence (PR #107 architect-review fix)', () => {
  const VERSION_A = 'archver-1';
  const VERSION_B = 'archver-2';

  it('the same signal converted against TWO architecture versions: TWO governed Work Items, TWO INDEPENDENT decision records — each record references ITS OWN version\'s Work Item', async () => {
    const signal = signalFixture();
    const { service, intake, records, ctx } = buildMultiVersionScenario({
      versionIds: [VERSION_A, VERSION_B],
      signals: [signal],
    });

    const resultA = await service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: VERSION_A },
      ctx,
    );
    const resultB = await service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: VERSION_B },
      ctx,
    );

    // BOTH versions propose (each version's fence is independent — the same
    // logical problem under a new version is fresh governed work).
    expect(resultA.decision).toBe('proposed');
    expect(resultB.decision).toBe('proposed');

    // TWO distinct authoritative Work Items (the DB fence scopes by version):
    expect(resultA.workItem?.id).not.toBe(resultB.workItem?.id);
    const itemsA = await intake.findByArchitectureVersion(VERSION_A);
    const itemsB = await intake.findByArchitectureVersion(VERSION_B);
    expect(itemsA.filter((wi) => wi.workItemId === resultA.conversionKey)).toHaveLength(1);
    expect(itemsB.filter((wi) => wi.workItemId === resultB.conversionKey)).toHaveLength(1);

    // THE DEFECT REGRESSION: the two decision records are INDEPENDENT —
    // record B is NOT a convergence onto record A, and each record
    // references ITS OWN version's Work Item (never the other's).
    expect(resultB.record.recordId).not.toBe(resultA.record.recordId);
    expect(resultA.record.architectureVersionId).toBe(VERSION_A);
    expect(resultB.record.architectureVersionId).toBe(VERSION_B);
    expect(resultA.record.workItemId).toBe(resultA.workItem?.id);
    expect(resultB.record.workItemId).toBe(resultB.workItem?.id);
    expect(resultA.record.workItemId).not.toBe(resultB.record.workItemId);

    // The append-only log holds BOTH records side by side, never converged:
    const history = await records.listForConversion(resultA.conversionKey);
    expect(history).toHaveLength(2);
    expect(history.map((r) => r.architectureVersionId).sort()).toEqual(
      [VERSION_A, VERSION_B].sort(),
    );
  });

  it('idempotent WITHIN each version: re-delivery converges (no second Work Item, no duplicate record) while the OTHER version stays independent', async () => {
    const signal = signalFixture();
    const { service, intake, records, ctx } = buildMultiVersionScenario({
      versionIds: [VERSION_A, VERSION_B],
      signals: [signal],
    });

    const first = await service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: VERSION_A },
      ctx,
    );
    const other = await service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: VERSION_B },
      ctx,
    );
    // Re-delivery of the SAME signal under version A: the open equivalent
    // in A exists → 'deduplicated' (converges, no second item in A).
    const again = await service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: VERSION_A },
      ctx,
    );
    expect(again.decision).toBe('deduplicated');
    expect(again.workItem?.id).toBe(first.workItem?.id);
    expect(again.record.recordId).not.toBe(first.record.recordId); // a NEW decision ('deduplicated') — the honest history
    const itemsA = await intake.findByArchitectureVersion(VERSION_A);
    expect(itemsA.filter((wi) => wi.workItemId === first.conversionKey)).toHaveLength(1);

    // The version-A history records both decisions; version B keeps its own:
    const history = await records.listForConversion(first.conversionKey);
    const versionAHistory = history.filter((r) => r.architectureVersionId === VERSION_A);
    const versionBHistory = history.filter((r) => r.architectureVersionId === VERSION_B);
    expect(versionAHistory.map((r) => r.decision).sort()).toEqual(
      ['deduplicated', 'proposed'].sort(),
    );
    expect(versionBHistory.map((r) => r.decision)).toEqual(['proposed']);
    expect(versionBHistory[0]?.recordId).toBe(other.record.recordId);
  });

  it('the RECURRENCE fence is version-scoped: a completed item in version A does not suppress the fresh proposal under version B', async () => {
    const signal = signalFixture();
    const { service, intake, ctx } = buildMultiVersionScenario({
      versionIds: [VERSION_A, VERSION_B],
      signals: [signal],
    });
    const inA = await service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: VERSION_A },
      ctx,
    );
    // The authority's internal completion path:
    intake.markCompleted(inA.workItem!.id);

    // Under version A: the completed equivalent → 'recurrence-recorded'.
    const againA = await service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: VERSION_A },
      ctx,
    );
    expect(againA.decision).toBe('recurrence-recorded');
    expect(againA.record.architectureVersionId).toBe(VERSION_A);
    expect(againA.record.workItemId).toBe(inA.workItem?.id);

    // Under version B: a FRESH governed proposal (version B's fence is empty).
    const inB = await service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: VERSION_B },
      ctx,
    );
    expect(inB.decision).toBe('proposed');
    expect(inB.workItem?.id).not.toBe(inA.workItem?.id);
    expect(inB.record.architectureVersionId).toBe(VERSION_B);
    expect(inB.record.workItemId).toBe(inB.workItem?.id);
    expect(inB.record.recordId).not.toBe(againA.record.recordId);
  });
});

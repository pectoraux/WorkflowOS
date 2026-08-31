import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the dogfooding-derived acceptance cases (§16).
 *
 * The 2026-08-31 customer dogfooding experiment exposed real product
 * defects. These cases make the tests REALISTIC without expanding scope:
 * the findings are context, never absorbed. Each case below uses a
 * realistic logical-failure-key shaped like the actual finding it
 * references — the conversion produces a governed proposal, NEVER a direct
 * behavioral change.
 */
import { buildService, signalFixture, readFeedback } from './helpers.js';

const VERSION = 'archver-1';

describe('WORK-068 — dogfooding-derived acceptance cases', () => {
  it('CASE 1 (validation failure → governed Work Item): a "dependency-blocked execution incorrectly admitted" signal becomes a governed PROPOSAL — never an execution-behavior change', async () => {
    // The dogfooding finding: a Work Item displayed as dependency-blocked
    // could nevertheless execute. The WORK-067-shaped advisory signal
    // describing that defect:
    const signal = signalFixture({
      signalId: 'sig_depblock_1',
      logicalFailureKey: 'validation:execution:dependency-blocked-admission',
      latestSeverity: 'critical',
      occurrences: [{ observedAt: '2026-08-31T14:00:00Z', severity: 'critical' }],
    });
    const { service, ctx, intake } = buildService({ signals: [signal] });
    const result = await service.convertSignal(
      { signalId: 'sig_depblock_1', architectureVersionId: VERSION }, ctx,
    );
    // The conversion PROPOSES governed work through the existing intake:
    expect(result.decision).toBe('proposed');
    expect(intake.countOpen()).toBe(1);
    expect(result.assessment.latestSeverity).toBe('critical');
    expect(result.priority.rank).toBe('P0');
    // ...and the result NEVER claims execution behavior changed (the
    // conversion layer owns no execution gating — that authority stays
    // where it belongs; the proposal records the problem honestly):
    expect(result.reasoning).toContain('proposed through the existing /work-items intake');
    expect(result.reasoning).not.toMatch(/execution (gating|blocked|enforced)/i);
  });

  it('CASE 2 (project-scoped failure): a signal concerning project X NEVER produces or deduplicates against a Work Item of project Y', async () => {
    const key = 'validation:execution:dependency-blocked-admission';
    const signalX = signalFixture({ signalId: 'sig_X', projectId: 'project-X', logicalFailureKey: key });
    const buildX = buildService({ signals: [signalX], projectId: 'project-X', versionId: 'archver-X' });
    const resultX = await buildX.service.convertSignal(
      { signalId: 'sig_X', architectureVersionId: buildX.versionId }, buildX.ctx,
    );
    // The created item lives in project X's version scope:
    const itemsX = await buildX.intake.findByArchitectureVersion(buildX.versionId);
    expect(itemsX).toHaveLength(1);
    // A project-Y conversion for the SAME logical failure is INDEPENDENT
    // (a separate project scope + a separate version + a separate item —
    // never a dedup against X's):
    const signalY = signalFixture({ signalId: 'sig_Y', projectId: 'project-Y', logicalFailureKey: key });
    const buildY = buildService({ signals: [signalY], projectId: 'project-Y', versionId: 'archver-Y' });
    const resultY = await buildY.service.convertSignal(
      { signalId: 'sig_Y', architectureVersionId: buildY.versionId }, buildY.ctx,
    );
    expect(resultY.decision).toBe('proposed');
    expect(resultY.conversionKey).not.toBe(resultX.conversionKey);
    expect(resultY.workItem?.workItemId).not.toBe(resultX.workItem?.workItemId);
    // The items live in SEPARATE authoritative stores (one per project scope):
    expect(await buildY.intake.findByArchitectureVersion(buildY.versionId)).toHaveLength(1);
    // And the cross-scope read NEVER sees the other project's item:
    expect(await buildY.intake.findByArchitectureVersion(buildX.versionId)).toHaveLength(0);
    expect(await buildX.intake.findByArchitectureVersion(buildY.versionId)).toHaveLength(0);
  });

  it('CASE 3 (repeated observation): repeated signals for the same unresolved issue CONVERGE — no backlog spam', async () => {
    const key = 'maintenance:project-access:creation-path-missing';
    // Multiple signals (the same logical problem observed repeatedly —
    // across environments and sources), each a distinct WORK-067 signal:
    const signals = [
      signalFixture({ signalId: 'sig_r1', logicalFailureKey: key, environmentId: 'env-prod-1', sources: ['validation'] }),
      signalFixture({ signalId: 'sig_r2', logicalFailureKey: key, environmentId: 'env-staging-1', sources: ['ci'] }),
      signalFixture({ signalId: 'sig_r3', logicalFailureKey: key, environmentId: 'env-prod-1', sources: ['runtime'] }),
    ];
    const { service, ctx, intake } = buildService({ signals });
    const results = [];
    for (const s of signals) {
      results.push(await service.convertSignal({ signalId: s.signalId, architectureVersionId: VERSION }, ctx));
    }
    expect(results.map((r) => r.decision)).toEqual(['proposed', 'deduplicated', 'deduplicated']);
    expect(intake.countOpen()).toBe(1);
    const items = await intake.findByArchitectureVersion(VERSION);
    const feedback = readFeedback(items[0]!).feedbackConversion as { contributingSignals: { signalId: string }[] };
    expect(feedback.contributingSignals).toHaveLength(3);
  });

  it('CASE 4 (severity): a CRITICAL signal is explainably prioritized ahead of a lower-severity equivalent backlog item — WITHOUT a second planning authority', async () => {
    const lowKey = 'maintenance:agent-output:visibility';
    const criticalKey = 'validation:execution:dependency-blocked-admission';
    const lowSignal = signalFixture({ signalId: 'sig_low', logicalFailureKey: lowKey, latestSeverity: 'low', occurrences: [{ observedAt: '2026-08-31T00:00:00Z', severity: 'low' }] });
    const criticalSignal = signalFixture({ signalId: 'sig_crit', logicalFailureKey: criticalKey, latestSeverity: 'critical', occurrences: [{ observedAt: '2026-08-31T00:00:00Z', severity: 'critical' }] });
    const { service, ctx, intake } = buildService({ signals: [lowSignal, criticalSignal] });
    const low = await service.convertSignal({ signalId: 'sig_low', architectureVersionId: VERSION }, ctx);
    const critical = await service.convertSignal({ signalId: 'sig_crit', architectureVersionId: VERSION }, ctx);
    expect(low.priority.rank).toBe('P3');
    expect(critical.priority.rank).toBe('P0');
    // The critical proposal's relative statement counts the OPEN lower-severity item:
    expect(critical.priority.backlogRelation).toContain('ranks ahead of 1 of 1 open Work Item');
    // ...and the statement stays explanatory (the planner owns the backlog):
    expect(critical.priority.backlogRelation).toContain('the WORK-040 planner owns all backlog ordering');
    expect(intake.countOpen()).toBe(2);
  });

  it('CASE 5 (existing open Work Item): a signal for an already-open item produces a DEDUPLICATION outcome — not another Work Item', async () => {
    const key = 'github:installation:customer-linking-path';
    const first = signalFixture({ signalId: 'sig_first', logicalFailureKey: key });
    const repeat = signalFixture({ signalId: 'sig_repeat', logicalFailureKey: key, environmentId: 'env-prod-2' });
    const { service, ctx, intake } = buildService({ signals: [first, repeat] });
    await service.convertSignal({ signalId: 'sig_first', architectureVersionId: VERSION }, ctx);
    const outcome = await service.convertSignal({ signalId: 'sig_repeat', architectureVersionId: VERSION }, ctx);
    expect(outcome.decision).toBe('deduplicated');
    expect(intake.countOpen()).toBe(1);
    expect(outcome.reasoning).toContain('NO second Work Item was created');
  });
});

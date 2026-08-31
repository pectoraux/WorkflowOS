import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WORK-068 — the module composition proofs: the domain is composed through
 * the EXISTING application composition (buildApp) and exposed on AppDeps —
 * the WORK-064/065/066/067 precedent. The barrel exports the full public
 * contract; the composition binds the in-memory decision-record repository
 * + the injected clock (the WORK-067 service + the existing work-item and
 * architecture repositories are supplied per-invocation through the
 * server-side context — the scope is derived server-side, never widened).
 */
import {
  DefaultFeedbackConversionService,
  InMemoryFeedbackConversionRecordRepository,
  CONVERSION_DECISION_STATUSES,
  CONVERSION_PRIORITY_RANKS,
  CONVERSION_FACTOR_KINDS,
  FEEDBACK_CONVERSION_ERROR_CODES,
  deriveConversionIdentity,
  type FeedbackConversionService,
} from '../../src/feedback-conversion/index.js';
import { buildService, signalFixture, fixedClock } from './helpers.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const APP_TS = join(REPO_ROOT, 'backend', 'src', 'app.ts');

describe('WORK-068 — module composition', () => {
  it('the barrel exports the complete public contract (the vocabularies, the errors, the service + the record-repository adapter)', () => {
    // the closed vocabularies
    expect([...CONVERSION_DECISION_STATUSES]).toEqual(['proposed', 'deduplicated', 'recurrence-recorded']);
    expect([...CONVERSION_PRIORITY_RANKS]).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect([...CONVERSION_FACTOR_KINDS]).toContain('signal-severity');
    expect([...CONVERSION_FACTOR_KINDS]).toContain('multi-environment-convergence');
    // the typed error surface (fail-closed codes)
    expect(FEEDBACK_CONVERSION_ERROR_CODES).toContain('FEEDBACK_SIGNAL_NOT_FOUND');
    expect(FEEDBACK_CONVERSION_ERROR_CODES).toContain('FEEDBACK_SIGNAL_PROJECT_MISMATCH');
    expect(FEEDBACK_CONVERSION_ERROR_CODES).toContain('FEEDBACK_INTAKE_UNAVAILABLE');
    expect(FEEDBACK_CONVERSION_ERROR_CODES).toContain('FEEDBACK_CONVERSION_IDENTITY_CONFLICT');
    // the composition classes
    expect(typeof DefaultFeedbackConversionService).toBe('function');
    expect(typeof InMemoryFeedbackConversionRecordRepository).toBe('function');
    expect(typeof deriveConversionIdentity).toBe('function');
  });

  it('the service is constructible with the documented composition deps (the in-memory record repository + the injected clock)', async () => {
    const service: FeedbackConversionService = new DefaultFeedbackConversionService({
      recordRepository: new InMemoryFeedbackConversionRecordRepository(),
      now: fixedClock('2026-09-03T00:00:00Z'),
    });
    const { ctx, versionId } = buildService({ signals: [signalFixture()] });
    const result = await service.convertSignal(
      { signalId: 'sig_abc123def456789abc123def', architectureVersionId: versionId }, ctx,
    );
    expect(result.decision).toBe('proposed');
    expect(result.record.decidedAt).toBe('2026-09-03T00:00:00.000Z');
  });

  it('app.ts composes the service (the in-memory record repository + the injected clock) and exposes it on AppDeps', () => {
    const appTs = readFileSync(APP_TS, 'utf8');
    // The import:
    expect(appTs).toMatch(/import\s*\{[^}]*DefaultFeedbackConversionService[^}]*\}\s*from\s*'\.\/feedback-conversion\/index\.js'/);
    expect(appTs).toMatch(/import\s+type\s*\{\s*FeedbackConversionService\s*\}\s*from\s*'\.\/feedback-conversion\/index\.js'/);
    // The AppDeps field:
    expect(appTs).toMatch(/feedbackConversionService\?:\s*FeedbackConversionService/);
    // The composition:
    expect(appTs).toMatch(/feedbackConversionService\s*=\s*new\s+DefaultFeedbackConversionService\(\{/);
    expect(appTs).toMatch(/new\s+InMemoryFeedbackConversionRecordRepository\(\)/);
    // The deps handle:
    expect(appTs).toMatch(/^\s*feedbackConversionService,$/m);
  });

  it('the service composes over the WORK-067 service + the /work-items intake ONLY through their PUBLIC boundaries (the context types)', () => {
    const ctx = buildService().ctx;
    // The context surface: the WORK-067 public reader + the /work-items
    // public intake + the architecture scope readers. No internal handles.
    const ctxKeys = Object.keys(ctx).sort();
    expect(ctxKeys).toEqual([
      'architectureRepository',
      'architectureVersionRepository',
      'engineeringSignalService',
      'projectId',
      'tenantId',
      'workItemRepository',
    ]);
    // The intake surface EXPOSES the authority's three public methods
    // (create / findByArchitectureVersion / update — the test fake adds
    // harness-only helpers, excluded from the contract check):
    const proto = Object.getPrototypeOf(ctx.workItemRepository) as Record<string, unknown>;
    for (const authorityMethod of ['create', 'findByArchitectureVersion', 'update']) {
      expect(typeof proto[authorityMethod]).toBe('function');
    }
    // The WORK-067 reader surface is the public findSignal only:
    const readerProto = Object.getPrototypeOf(ctx.engineeringSignalService) as Record<string, unknown>;
    expect(typeof readerProto.findSignal).toBe('function');
  });

  it('listConversions ENFORCES the tenant predicate (the PR #107 architect-review secondary fix): the caller tenant sees ONLY its own decision history — never another tenant\'s', async () => {
    // One project id, TWO tenants' decision records in the log (the
    // record-level history a shared project id string could ever hold):
    const records = new InMemoryFeedbackConversionRecordRepository();
    const service = new DefaultFeedbackConversionService({
      recordRepository: records,
      now: fixedClock('2026-09-03T00:00:00Z'),
    });
    const seed = async (tenantId: string, signalId: string, versionId: string) => {
      await records.append({
        recordId: `SIGWIR-${tenantId}-${signalId}-${versionId}`,
        conversionKey: `SIGWI-${tenantId}-${signalId}`,
        architectureVersionId: versionId,
        tenantId,
        projectId: 'project-1',
        signalId,
        decision: 'proposed',
        workItemId: `wi-${tenantId}`,
        workItemHumanId: `SIGWI-${tenantId}-${signalId}`,
        decidedAt: '2026-09-03T00:00:00Z',
        summary: `seed ${tenantId}`,
      });
    };
    await seed('tenant-A', 'sig_a1', 'archver-1');
    await seed('tenant-A', 'sig_a2', 'archver-1');
    await seed('tenant-B', 'sig_b1', 'archver-1');

    // Tenant A's caller: ONLY tenant A's records.
    const forA = await service.listConversions('project-1', { tenantId: 'tenant-A' });
    expect(forA.map((r) => r.tenantId)).toEqual(['tenant-A', 'tenant-A']);
    expect(forA.map((r) => r.signalId).sort()).toEqual(['sig_a1', 'sig_a2'].sort());

    // Tenant B's caller: ONLY tenant B's records (never A's — the predicate
    // is enforced, never accepted-and-ignored).
    const forB = await service.listConversions('project-1', { tenantId: 'tenant-B' });
    expect(forB.map((r) => r.tenantId)).toEqual(['tenant-B']);
    expect(forB.map((r) => r.signalId)).toEqual(['sig_b1']);

    // A tenant with NO history in the project sees an empty list (not a
    // failure, not another tenant's data):
    const forC = await service.listConversions('project-1', { tenantId: 'tenant-C' });
    expect(forC).toEqual([]);
  });
});

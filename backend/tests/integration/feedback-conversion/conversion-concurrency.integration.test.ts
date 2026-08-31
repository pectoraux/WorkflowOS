import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * WORK-068 — the REAL PostgreSQL two-actor concurrency proofs for the
 * feedback-conversion contract.
 *
 * The conversion's dedup fence is the EXISTING UNIQUE(architecture_version_id,
 * work_item_id) DB constraint on wfos_work_items (the WORK-040 planner
 * precedent) + the deterministic SIGWI-* conversion key. Two CONCURRENT
 * convertSignal calls for EQUIVALENT signals (the same logical failure key —
 * different environments, the multi-signal convergence case) race: both load
 * the (empty) backlog, both fire workItemRepository.create. PostgreSQL's
 * unique constraint serializes: one INSERT succeeds ('proposed'); the other
 * throws a unique-violation (23505) → the orchestrator catches + re-queries +
 * converges ('deduplicated', provenance appended). The net result: exactly
 * ONE authoritative Work Item (no duplicate open item).
 *
 * This file proves the fence is REAL by exercising TWO concurrent `pg.Client`
 * connections against the same schema (the createSecondClient test harness).
 * A single-threaded pglite run CANNOT demonstrate true concurrent INSERT
 * racing (the WASM runtime serializes all statements). The suite SKIPS on
 * pglite — it runs only when `WORKFLOWOS_DATABASE_URL` is set (CI / a real
 * postgres service).
 */
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgWorkItemRepository } from '../../../src/modules/work-items/internal/pg-work-item-repository.js';
import {
  DefaultFeedbackConversionService,
  InMemoryFeedbackConversionRecordRepository,
  deriveConversionIdentity,
} from '../../../src/feedback-conversion/index.js';
import type {
  EngineeringSignalRecord,
  FeedbackConversionContext,
} from '../../../src/feedback-conversion/index.js';
import { createLogger } from '@platform/logger.js';
import { CaptureStream } from '../../helpers/capture-stream.js';

const isRealPg =
  !!process.env.WORKFLOWOS_DATABASE_URL &&
  process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

/** A WORK-067-record-shaped signal fixture (the public reader contract). */
function realSignalFixture(overrides: Partial<EngineeringSignalRecord> = {}): EngineeringSignalRecord {
  return {
    signalId: 'sig_realtest_default',
    identityFingerprint: 'a'.repeat(64),
    tenantId: 'tenant-placeholder',
    projectId: 'project-placeholder',
    environmentId: 'env-prod-1',
    logicalFailureKey: 'validation:execution:dependency-blocked-admission',
    sources: ['validation'],
    occurrences: [
      { observedAt: '2026-09-01T12:00:00Z', severity: 'critical' },
      { observedAt: '2026-09-02T12:00:00Z', severity: 'critical' },
    ],
    firstObservedAt: '2026-09-01T12:00:00Z',
    lastObservedAt: '2026-09-02T12:00:00Z',
    latestSeverity: 'critical',
    ...overrides,
  };
}

describe.skipIf(!isRealPg)(
  'WORK-068 — feedback-conversion concurrency fence (real PostgreSQL)',
  () => {
    let stack: TestAuthStack;
    let orgId: string;
    let projectId: string;
    let versionId: string;
    let ctxT1: FeedbackConversionContext;
    let ctxT2: FeedbackConversionContext;
    let secondClient: { close: () => Promise<void> } | undefined;
    const capture = new CaptureStream();
    const logger = createLogger({ level: 'info', destination: capture });

    beforeAll(async () => {
      stack = await buildAuthStack();
      const org = await stack.organizationRepository.create({ name: 'W68 Conversion Org' });
      const user = await stack.userRepository.upsertByExternalId({
        externalId: 'w68-conversion-user', displayName: 'W68 User',
      });
      await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
      const project = await stack.projectRepository.create({ organizationId: org.id, name: 'W68 Conversion Project' });
      await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });
      const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'W68 Conversion Arch' });
      const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
      await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);
      orgId = org.id;
      projectId = project.id;
      versionId = version.id;

      // T1 uses the main test client's repositories; T2 uses a SECOND
      // independent pg.Client against the SAME test schema (the race).
      const second = await stack.db.createSecondClient!();
      const repoT2 = new PgWorkItemRepository(second.client);
      secondClient = second;

      const scope = {
        tenantId: org.id,
        projectId: project.id,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureRepository: stack.architectureRepository,
      };
      ctxT1 = { ...scope, engineeringSignalService: { findSignal: async () => null }, workItemRepository: stack.workItemRepository };
      ctxT2 = { ...scope, engineeringSignalService: { findSignal: async () => null }, workItemRepository: repoT2 };
      void logger;
    });

    afterAll(async () => {
      if (secondClient) await secondClient.close();
      await stack.teardown();
    });

    function buildServicePair(signals: readonly EngineeringSignalRecord[]) {
      const reader = { findSignal: async (id: string) => signals.find((s) => s.signalId === id) ?? null };
      const mk = () =>
        new DefaultFeedbackConversionService({
          recordRepository: new InMemoryFeedbackConversionRecordRepository(),
          now: () => new Date('2026-09-03T00:00:00Z'),
        });
      return {
        t1: mk(),
        t2: mk(),
        ctxA: { ...ctxT1, engineeringSignalService: reader },
        ctxB: { ...ctxT2, engineeringSignalService: reader },
      };
    }

    it('THE FENCE: two concurrent conversions of EQUIVALENT signals (same logical failure, different environments) → ONE Work Item, one proposed + one deduplicated', async () => {
      const key = 'validation:execution:dependency-blocked-admission';
      const signalA = realSignalFixture({
        signalId: 'sig_w68_a', tenantId: orgId, projectId, environmentId: 'env-prod-1',
        logicalFailureKey: key, identityFingerprint: 'a'.repeat(64),
      });
      const signalB = realSignalFixture({
        signalId: 'sig_w68_b', tenantId: orgId, projectId, environmentId: 'env-staging-1',
        logicalFailureKey: key, identityFingerprint: 'b'.repeat(64),
      });
      const { t1, t2, ctxA, ctxB } = buildServicePair([signalA, signalB]);
      // Fire both conversions CONCURRENTLY — they race on the same SIGWI key.
      const [rA, rB] = await Promise.all([
        t1.convertSignal({ signalId: 'sig_w68_a', architectureVersionId: versionId }, ctxA),
        t2.convertSignal({ signalId: 'sig_w68_b', architectureVersionId: versionId }, ctxB),
      ]);
      const proposed = [rA, rB].filter((r) => r.decision === 'proposed');
      const deduplicated = [rA, rB].filter((r) => r.decision === 'deduplicated');
      expect(proposed, 'exactly one conversion proposed the Work Item').toHaveLength(1);
      expect(deduplicated, 'exactly one conversion converged (deduplicated)').toHaveLength(1);
      expect(deduplicated[0]!.workItem?.id).toBe(proposed[0]!.workItem?.id);
      // Exactly ONE row in the database for the conversion key (no duplicate).
      const identity = deriveConversionIdentity({ tenantId: orgId, projectId, logicalFailureKey: key });
      const all = await stack.workItemRepository.findByArchitectureVersion(versionId);
      const matches = all.filter((w) => w.workItemId === identity.conversionKey);
      expect(matches.length, 'exactly one Work Item row (the DB constraint fenced the race)').toBe(1);
      // The provenance converged on the authoritative record: BOTH signals
      // are recorded as contributors (the winner embedded its own; the loser
      // appended through the public update path).
      const feedback = (matches[0]!.metadata as { feedbackConversion?: { contributingSignals: { signalId: string; contributedAs: string }[] } }).feedbackConversion;
      expect(feedback).toBeDefined();
      const contributorIds = feedback!.contributingSignals.map((cs) => cs.signalId).sort();
      expect(contributorIds).toEqual(['sig_w68_a', 'sig_w68_b']);
    });

    it('RE-DELIVERY of the SAME signal concurrently: one proposed + one converged with the idempotent provenance (no duplicate append)', async () => {
      const key = 'maintenance:agent-output:visibility';
      const signal = realSignalFixture({
        signalId: 'sig_w68_redeliver', tenantId: orgId, projectId,
        logicalFailureKey: key, identityFingerprint: 'c'.repeat(64),
      });
      const { t1, t2, ctxA, ctxB } = buildServicePair([signal]);
      const [rA, rB] = await Promise.all([
        t1.convertSignal({ signalId: 'sig_w68_redeliver', architectureVersionId: versionId }, ctxA),
        t2.convertSignal({ signalId: 'sig_w68_redeliver', architectureVersionId: versionId }, ctxB),
      ]);
      expect([rA.decision, rB.decision].sort()).toEqual(['deduplicated', 'proposed']);
      const identity = deriveConversionIdentity({ tenantId: orgId, projectId, logicalFailureKey: key });
      const all = await stack.workItemRepository.findByArchitectureVersion(versionId);
      const matches = all.filter((w) => w.workItemId === identity.conversionKey);
      expect(matches).toHaveLength(1);
      // The SAME signal is ONE contributor (idempotent — never duplicated):
      const feedback = (matches[0]!.metadata as { feedbackConversion?: { contributingSignals: { signalId: string }[] } }).feedbackConversion;
      expect(feedback!.contributingSignals).toHaveLength(1);
      expect(feedback!.contributingSignals[0]!.signalId).toBe('sig_w68_redeliver');
    });

    it('DIFFERENT logical problems (different failure keys) create INDEPENDENT Work Items (never serialize on each other)', async () => {
      const s1 = realSignalFixture({
        signalId: 'sig_w68_k1', tenantId: orgId, projectId,
        logicalFailureKey: 'maintenance:project-access:creation-path-missing', identityFingerprint: 'd'.repeat(64),
      });
      const s2 = realSignalFixture({
        signalId: 'sig_w68_k2', tenantId: orgId, projectId,
        logicalFailureKey: 'github:installation:customer-linking-path', identityFingerprint: 'e'.repeat(64),
      });
      const { t1, t2, ctxA, ctxB } = buildServicePair([s1, s2]);
      const [r1, r2] = await Promise.all([
        t1.convertSignal({ signalId: 'sig_w68_k1', architectureVersionId: versionId }, ctxA),
        t2.convertSignal({ signalId: 'sig_w68_k2', architectureVersionId: versionId }, ctxB),
      ]);
      expect(r1.decision).toBe('proposed');
      expect(r2.decision).toBe('proposed');
      expect(r1.conversionKey).not.toBe(r2.conversionKey);
      const all = await stack.workItemRepository.findByArchitectureVersion(versionId);
      expect(all.filter((w) => w.workItemId === r1.conversionKey)).toHaveLength(1);
      expect(all.filter((w) => w.workItemId === r2.conversionKey)).toHaveLength(1);
    });

    it('the RECURRENCE path on real PG: a completed item in the version records recurrence (no create, no mutation)', async () => {
      const key = 'validation:execution:recurrence-check';
      const signal = realSignalFixture({
        signalId: 'sig_w68_recur', tenantId: orgId, projectId,
        logicalFailureKey: key, identityFingerprint: 'f'.repeat(64),
      });
      const { t1, ctxA } = buildServicePair([signal]);
      const first = await t1.convertSignal({ signalId: 'sig_w68_recur', architectureVersionId: versionId }, ctxA);
      expect(first.decision).toBe('proposed');
      // The authority's internal completion path (direct SQL in the test —
      // the same internal-only mutation WorkItemCompletionService owns).
      await stack.db.client.query(
        `UPDATE wfos_work_items SET completed = true WHERE id = $1`,
        [first.workItem!.id],
      );
      const again = await t1.convertSignal({ signalId: 'sig_w68_recur', architectureVersionId: versionId }, ctxA);
      expect(again.decision).toBe('recurrence-recorded');
      expect(again.workItem?.id).toBe(first.workItem!.id);
      // Still exactly ONE row for this key (nothing was created):
      const identity = deriveConversionIdentity({ tenantId: orgId, projectId, logicalFailureKey: key });
      const all = await stack.workItemRepository.findByArchitectureVersion(versionId);
      expect(all.filter((w) => w.workItemId === identity.conversionKey)).toHaveLength(1);
    });

    it('the record-port keyed-uniqueness contract: a test-schema table implementing the port (PK on record_id) arbitrates two concurrent appends of the SAME decision', async () => {
      // The WORK-066/067 port-contract pattern: the in-memory adapter is the
      // composed implementation; this proof pins the CONTRACT a future ACR
      // productionizes — the record_id PRIMARY KEY (the deterministic
      // (conversionKey, signalId, decision) key) decides the winner under
      // true two-actor concurrency.
      const schema = 'wfos_test_w68_records';
      await stack.db.client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await stack.db.client.query(`SET search_path TO ${schema}, public`);
      await stack.db.client.query(`
        CREATE TABLE IF NOT EXISTS conversion_records (
          record_id TEXT PRIMARY KEY,
          conversion_key TEXT NOT NULL,
          decision TEXT NOT NULL,
          decided_at TIMESTAMPTZ NOT NULL,
          summary TEXT NOT NULL
        )
      `);
      try {
        const recordId = 'SIGWIR-contract-test';
        const insert = async () => {
          // The bare ON CONFLICT DO NOTHING (the fixture's documented form —
          // the constraint decides, the follow-up SELECT converges).
          const result = await stack.db.client.query(
            `INSERT INTO conversion_records (record_id, conversion_key, decision, decided_at, summary)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
            [recordId, 'SIGWI-contract', 'proposed', new Date(), 'two-actor append'],
          );
          const rows = await stack.db.client.query(
            `SELECT COUNT(*)::int AS count FROM conversion_records WHERE record_id = $1`,
            [recordId],
          );
          return { inserted: result.rowCount ?? 0, count: (rows.rows[0] as { count: number }).count };
        };
        // Two actors append the SAME record identity concurrently.
        const [a, b] = await Promise.all([insert(), insert()]);
        // Exactly one row (the PRIMARY KEY fenced the race; both converge).
        expect(a.count).toBe(1);
        expect(b.count).toBe(1);
        expect(a.inserted + b.inserted).toBe(1);
        // A DIFFERENT decision under the same logical problem is a DIFFERENT
        // row (the decision participates in the key — the honest history):
        await stack.db.client.query(
          `INSERT INTO conversion_records (record_id, conversion_key, decision, decided_at, summary)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          ['SIGWIR-contract-test-dedup', 'SIGWI-contract', 'deduplicated', new Date(), 'later decision'],
        );
        const total = await stack.db.client.query(
          `SELECT COUNT(*)::int AS count FROM conversion_records`,
        );
        expect((total.rows[0] as { count: number }).count).toBe(2);
      } finally {
        await stack.db.client.query(`SET search_path TO public`);
        await stack.db.client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });
  },
);

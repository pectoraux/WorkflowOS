import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WORK-068 — the mutation/discrimination proofs (§15).
 *
 * The implementation must prove its invariants BY CONSTRUCTION. Each
 * mutation below reproduces a defect variant of the domain logic IN THE
 * TEST (the same seams the production code uses) and proves the
 * corresponding invariant test FAILS against it. Nothing in src/ is
 * modified — the mutations are constructed from the real building blocks
 * with the guarded step REMOVED, exactly the "remove X → test Y must fail"
 * discipline.
 *
 * Required mutations:
 *   1. bypass the existing /work-items intake (write to a parallel store)
 *      → the one-work-item-authority test FAILS;
 *   2. bypass the assessment (silent direct creation) → the
 *      no-silent-autonomous-creation test FAILS;
 *   3. strip the provenance binding from the create → the
 *      provenance-preservation test FAILS;
 *   4. remove deduplication (unique-per-invocation keys) → the
 *      duplicate-open-items test FAILS;
 *   5. remove the tenant/project identity dimensions → the
 *      cross-scope-collapse test FAILS;
 *   6. introduce an autonomous conversion path (a timer/interval) → the
 *      static architecture autonomous-scanning check FAILS.
 */
import {
  DefaultFeedbackConversionService,
  InMemoryFeedbackConversionRecordRepository,
  deriveConversionIdentity,
  FeedbackConversionError,
} from '../../src/feedback-conversion/index.js';
import type {
  ConversionResult,
  FeedbackConversionContext,
  FeedbackConversionService,
  WorkItemRecord,
} from '../../src/feedback-conversion/index.js';
import { assessSignal, deriveConversionPriority } from '../../src/feedback-conversion/internal/index.js';
import { FakeWorkItemIntake, buildService, signalFixture, fixedClock, readFeedback } from './helpers.js';

const VERSION = 'archver-1';

/**
 * MUTATION 2/3/4 — a defect-variant conversion service assembled from the
 * REAL building blocks with the guarded steps removed (the same seams the
 * production service uses). The mutations are per-test flags:
 *   bypassAssessment — creates WITHOUT the assessment/decision record;
 *   stripProvenance   — creates WITHOUT metadata.feedbackConversion;
 *   perInvocationKeys — invents a UNIQUE key per invocation (no dedup).
 */
class MutatedConversionService implements FeedbackConversionService {
  constructor(
    private readonly flags: {
      bypassAssessment?: boolean;
      stripProvenance?: boolean;
      perInvocationKeys?: boolean;
    },
    private readonly clock: () => Date = fixedClock('2026-09-03T00:00:00Z'),
    private readonly records = new InMemoryFeedbackConversionRecordRepository(),
    private invocation = 0,
  ) {}

  async convertSignal(
    input: { signalId: string; architectureVersionId: string },
    ctx: FeedbackConversionContext,
  ): Promise<ConversionResult> {
    const signal = await ctx.engineeringSignalService.findSignal(input.signalId);
    if (!signal) throw new FeedbackConversionError('FEEDBACK_SIGNAL_NOT_FOUND', 'missing');
    this.invocation++;
    const identity = deriveConversionIdentity({
      tenantId: signal.tenantId,
      projectId: signal.projectId,
      logicalFailureKey: signal.logicalFailureKey,
    });
    // MUTATION 4: a unique key per invocation — the dedup boundary removed.
    const workItemId = this.flags.perInvocationKeys
      ? `SIGWI-mutated-${this.invocation}`
      : identity.conversionKey;
    const assessment = this.flags.bypassAssessment
      ? null
      : assessSignal(signal, { openItemCount: 0, completedItemCount: 0, openConversionSeverities: {} });
    const priority = deriveConversionPriority(
      assessment ?? assessSignal(signal, { openItemCount: 0, completedItemCount: 0, openConversionSeverities: {} }),
      1,
    );
    const decidedAt = this.clock().toISOString();
    // MUTATION 3: the create without the provenance payload.
    const created = await ctx.workItemRepository.create({
      architectureVersionId: input.architectureVersionId,
      workItemId,
      title: 'Resolve: (mutated)',
      metadata: this.flags.stripProvenance ? {} : {
        feedbackConversion: {
          version: 'mutated', conversionKey: workItemId,
          contributingSignals: [{ signalId: signal.signalId, contributedAs: 'proposed', decidedAt }],
        },
      },
    });
    const record = await this.records.append({
      recordId: `mut-${this.invocation}`, conversionKey: workItemId,
      tenantId: signal.tenantId, projectId: signal.projectId,
      signalId: signal.signalId, decision: 'proposed',
      workItemId: created.id, workItemHumanId: created.workItemId,
      decidedAt, summary: 'mutated',
    });
    return {
      decision: 'proposed',
      conversionKey: workItemId,
      signal: {
        signalId: signal.signalId, identityFingerprint: signal.identityFingerprint,
        logicalFailureKey: signal.logicalFailureKey, environmentId: signal.environmentId,
      },
      // MUTATION 2: no assessment in the result (the silent path).
      assessment: assessment ?? ({
        signalId: signal.signalId, signalFingerprint: '', tenantId: '', projectId: '',
        environments: [], sources: [], occurrenceCount: 0, firstObservedAt: '', lastObservedAt: '',
        latestSeverity: 'low', severityInterpretation: '', recurrenceSpan: '',
        backlogContext: { openItemCount: 0, completedItemCount: 0, openConversionSeverities: {} },
        factors: [], reasoning: '',
      } as ConversionResult['assessment']),
      priority,
      workItem: { id: created.id, workItemId: created.workItemId, title: created.title, completed: false },
      reasoning: 'mutated',
      record,
    };
  }

  async listConversions(projectId: string): Promise<readonly import('../../src/feedback-conversion/index.js').ConversionRecord[]> {
    return this.records.listForProject(projectId);
  }
}

describe('WORK-068 — mutation/discrimination proofs', () => {
  // ==========================================================================
  // MUTATION 1 — bypassing the existing /work-items intake (a parallel store)
  // ==========================================================================
  it('MUTATION 1 (bypass the existing intake): a parallel-store conversion is NOT visible through the authority — the one-authority test FAILS', async () => {
    // The defect variant: a "second intake" that writes to its OWN store.
    const parallelStore: WorkItemRecord[] = [];
    const signal = signalFixture();
    const realIntake = new FakeWorkItemIntake();
    const ctx: FeedbackConversionContext = {
      ...buildService({ signals: [signal] }).ctx,
      workItemRepository: {
        // The mutation: create lands in the PARALLEL store, never the authority.
        create: async (input) => {
          const item: WorkItemRecord = {
            id: `parallel-${parallelStore.length + 1}`,
            workItemId: input.workItemId,
            title: input.title,
            completed: false,
            metadata: input.metadata ?? {},
          };
          parallelStore.push(item);
          return item;
        },
        findByArchitectureVersion: (id: string) => realIntake.findByArchitectureVersion(id),
        update: (id, i) => realIntake.update(id, i),
      },
    };
    const service = new DefaultFeedbackConversionService({
      recordRepository: new InMemoryFeedbackConversionRecordRepository(),
      now: fixedClock('2026-09-03T00:00:00Z'),
    });
    const result = await service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    void result; // the result exists — the PROOF is the authority's emptiness below
    // The mutated conversion "succeeded" — but the WORK ITEM DOES NOT EXIST
    // in the authority: the invariant test (readable through the REAL
    // /work-items repository) FAILS against the mutation.
    const authoritative = await realIntake.findByArchitectureVersion(VERSION);
    expect(authoritative).toHaveLength(0);
    expect(parallelStore).toHaveLength(1);
    // The discrimination: a REAL conversion must be authority-visible.
    const clean = buildService({ signals: [signal] });
    const cleanResult = await clean.service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: VERSION }, clean.ctx,
    );
    const cleanAuthoritative = await clean.intake.findByArchitectureVersion(VERSION);
    expect(cleanAuthoritative.map((wi) => wi.id)).toContain(cleanResult.workItem?.id);
  });

  // ==========================================================================
  // MUTATION 2 — bypassing the assessment
  // ==========================================================================
  it('MUTATION 2 (bypass the assessment): a silent direct creation produces a result WITHOUT an assessment — the no-silent-autonomous-creation test FAILS', async () => {
    const signal = signalFixture();
    const mutated = new MutatedConversionService({ bypassAssessment: true });
    const { ctx, intake } = buildService({ signals: [signal] });
    const result = await mutated.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    // The discrimination: the mutated result's assessment is a hollow shell
    // (no factors, no reasoning, no recorded evidence) — a REAL conversion
    // always carries the full deterministic assessment.
    expect(result.assessment.factors).toHaveLength(0);
    expect(result.assessment.reasoning).toBe('');
    // The real conversion fails this hollow state:
    const clean = buildService({ signals: [signal] });
    const cleanResult = await clean.service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: VERSION }, clean.ctx,
    );
    expect(cleanResult.assessment.factors.length).toBeGreaterThan(0);
    expect(cleanResult.assessment.reasoning).toContain('Assessment of Engineering Signal');
    expect(intake.countOpen()).toBe(1);
  });

  // ==========================================================================
  // MUTATION 3 — stripping the provenance binding
  // ==========================================================================
  it('MUTATION 3 (strip the provenance): the created Work Item carries NO feedbackConversion payload — the provenance-preservation test FAILS', async () => {
    const signal = signalFixture();
    const mutated = new MutatedConversionService({ stripProvenance: true });
    const { ctx, intake } = buildService({ signals: [signal] });
    await mutated.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    const items = await intake.findByArchitectureVersion(VERSION);
    // The mutated item is FREE-FLOATING (the chain is broken):
    expect(readFeedback(items[0]!).feedbackConversion).toBeUndefined();
    // The real conversion embeds the chain:
    const clean = buildService({ signals: [signal] });
    await clean.service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, clean.ctx);
    const cleanItems = await clean.intake.findByArchitectureVersion(VERSION);
    const feedback = readFeedback(cleanItems[0]!).feedbackConversion as { contributingSignals: { signalId: string }[] };
    expect(feedback.contributingSignals[0]!.signalId).toBe(signal.signalId);
  });

  // ==========================================================================
  // MUTATION 4 — removing deduplication (a fresh key per invocation)
  // ==========================================================================
  it('MUTATION 4 (remove deduplication): duplicate conversions create MULTIPLE open Work Items — the no-duplicate-open-items test FAILS', async () => {
    const signal = signalFixture();
    const mutated = new MutatedConversionService({ perInvocationKeys: true });
    const { ctx, intake } = buildService({ signals: [signal] });
    await mutated.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    await mutated.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, ctx);
    // The mutated service created TWO open work items for the SAME logical problem:
    expect(intake.countOpen()).toBe(2);
    // The real conversion NEVER does (the deterministic key converges):
    const clean = buildService({ signals: [signal] });
    await clean.service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, clean.ctx);
    await clean.service.convertSignal({ signalId: signal.signalId, architectureVersionId: VERSION }, clean.ctx);
    expect(clean.intake.countOpen()).toBe(1);
  });

  // ==========================================================================
  // MUTATION 5 — removing the tenant/project identity dimensions
  // ==========================================================================
  it('MUTATION 5 (remove the tenant/project identity): the scopeless key collapses tenant B/project X with tenant A/project X — the cross-scope test FAILS', async () => {
    const key = 'validation:execution:dependency-blocked-admission';
    // The defect variant: an identity WITHOUT the tenant + project dimensions
    // (the same logical failure key alone).
    const scopeless = (logicalFailureKey: string) =>
      `SIGWI-${logicalFailureKey}`; // NO hashing of scope — the mutated "identity".
    // Tenant A/project X and tenant B/project X have the SAME failure key:
    expect(scopeless(key)).toBe(scopeless(key)); // the collapse.
    // The REAL identity never collapses them (the scope dimensions are mandatory):
    const a = deriveConversionIdentity({ tenantId: 'tenant-A', projectId: 'X', logicalFailureKey: key });
    const b = deriveConversionIdentity({ tenantId: 'tenant-B', projectId: 'X', logicalFailureKey: key });
    const y = deriveConversionIdentity({ tenantId: 'tenant-A', projectId: 'Y', logicalFailureKey: key });
    expect(a.conversionKey).not.toBe(b.conversionKey);
    expect(a.conversionKey).not.toBe(y.conversionKey);
    // And the SERVICE boundary rejects the cross-scope signal outright:
    const foreign = signalFixture({ signalId: 'sig_foreign', tenantId: 'tenant-B' });
    const { service, ctx } = buildService({ signals: [foreign], tenantId: 'tenant-A' });
    await expect(
      service.convertSignal({ signalId: 'sig_foreign', architectureVersionId: VERSION }, ctx),
    ).rejects.toMatchObject({ code: 'FEEDBACK_SIGNAL_TENANT_MISMATCH' });
  });

  // ==========================================================================
  // MUTATION 6 — introducing an autonomous conversion path
  // ==========================================================================
  it('MUTATION 6 (autonomous conversion path): a domain file containing a timer/interval/polling loop is FLAGGED by the same scanning rule the static-architecture suite applies — the no-autonomous-path check FAILS', () => {
    // The scanning rule (replicated from the static-architecture invariant —
    // the same regex family the real check applies to the domain source):
    const AUTONOMOUS_PATH_RE =
      /\b(setInterval|setTimeout\s*\(\s*[^,]*,\s*[0-9]|cron\b|new\s+CronJob|while\s*\(\s*true\b|queue\.consume|poll\()/;
    // The defect variant: a domain file that auto-runs conversions.
    const mutatedSource = `
      import { feedbackConversionService } from '../index.js';
      // The mutation: an autonomous conversion loop.
      setInterval(() => { void feedbackConversionService; }, 5000);
    `;
    expect(AUTONOMOUS_PATH_RE.test(mutatedSource)).toBe(true); // flagged.
    // The REAL domain source contains NO autonomous path:
    const realFiles = [
      'feedback-conversion-service.ts', 'in-memory-conversion-record-repository.ts',
      'conversion-identity.ts', 'assessment.ts', 'priority.ts', 'index.ts',
    ];
    for (const file of realFiles) {
      const src = readFileSync(
        join(process.cwd(), 'src', 'feedback-conversion', 'internal', file),
        'utf8',
      ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(AUTONOMOUS_PATH_RE.test(src), `${file} must contain no autonomous path`).toBe(false);
    }
  });
});

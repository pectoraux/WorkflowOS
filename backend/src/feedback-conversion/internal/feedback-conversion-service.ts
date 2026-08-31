/**
 * WORK-068 — the default feedback-conversion service (the orchestrator).
 *
 * THE CANONICAL FLOW (one explicit governed invocation — never autonomous):
 *
 *   Engineering Signal (read through the WORK-067 PUBLIC service)
 *     ↓ scope assertions (tenant + project — fail closed)
 *   assessment (deterministic, explainable, evidence-cited)
 *     ↓
 *   deduplication against existing OPEN Work Items (the deterministic
 *     conversion key; the existing UNIQUE(architecture_version_id,
 *     work_item_id) DB constraint is the persistence-level fence)
 *     ↓
 *   conversion-relative priority (never a planning engine)
 *     ↓
 *   PROPOSED Work Item THROUGH the existing `/work-items` public intake
 *     (WorkItemRepository.create — the single creation path, the WORK-040
 *     planner precedent; the provenance payload embedded in
 *     metadata.feedbackConversion)
 *     ↓
 *   the decision record (append-only log)
 *
 * AUTHORITY BOUNDARY (enforced statically in static-architecture.test.ts):
 *   * the service CREATES Work Items via the existing public
 *     WorkItemRepository.create and APPENDS provenance via the existing
 *     public update — it owns NO tables, NO second model, NO second intake;
 *   * it NEVER transitions workflow state, NEVER starts implementation,
 *     NEVER creates/merges PRs, NEVER approves anything (invariant 6 — the
 *     full governance lifecycle stays in the existing authorities);
 *   * it NEVER reorders the backlog or assigns scheduling (invariant 5 —
 *     WORK-040 remains the ONE planning authority);
 *   * it NEVER runs timers/loops/queues (invariant 2 — no autonomous path).
 */
import type {
  ContributingSignal,
  ConversionAssessment,
  ConversionPriority,
  ConversionRecord,
  ConversionResult,
  FeedbackConversionContext,
  FeedbackConversionMetadata,
  FeedbackConversionRecordRepository,
  FeedbackConversionService,
  ConvertSignalInput,
  WorkItemRecord,
} from '../types.js';
import { FeedbackConversionError } from '../types.js';
import {
  deriveArchitectureImpact,
  deriveConversionIdentity,
  deriveConversionRecordId,
  deriveProposalObjective,
  deriveProposalTitle,
} from './conversion-identity.js';
import { assessSignal, deriveBacklogContext } from './assessment.js';
import { deriveConversionPriority } from './priority.js';

/** The conversion-domain version stamp (embedded in every metadata payload). */
const CONVERSION_VERSION = 'work-068.v1';

/**
 * Detect whether a thrown error is a PostgreSQL unique-violation (SQLSTATE
 * 23505) — the WORK-040 planner precedent (driver-agnostic defensive read).
 * A unique-violation on wfos_work_items means a CONCURRENT conversion
 * created the same (architecture_version_id, work_item_id) between our load
 * and our insert → catch + re-query → CONVERGE (no duplicate, no failure).
 */
function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === '23505';
}

export interface DefaultFeedbackConversionServiceDeps {
  /** The append-only decision-log port (in-memory adapter — NO migration). */
  readonly recordRepository: FeedbackConversionRecordRepository;
  /** The injected clock (deterministic decisions; no implicit global time). */
  readonly now?: () => Date;
}

export class DefaultFeedbackConversionService implements FeedbackConversionService {
  private readonly recordRepository: FeedbackConversionRecordRepository;
  private readonly now: () => Date;

  constructor(deps: DefaultFeedbackConversionServiceDeps) {
    this.recordRepository = deps.recordRepository;
    this.now = deps.now ?? (() => new Date());
  }

  async convertSignal(
    input: ConvertSignalInput,
    ctx: FeedbackConversionContext,
  ): Promise<ConversionResult> {
    // --- scope re-assertion (defense in depth — a UUID is NEVER an
    // authorization credential; the planner precedent): the target
    // architecture version must exist AND belong to ctx.projectId.
    const version = await ctx.architectureVersionRepository.findById(
      input.architectureVersionId,
    );
    if (!version) {
      throw new FeedbackConversionError(
        'FEEDBACK_ARCHITECTURE_VERSION_NOT_FOUND',
        `architecture version ${input.architectureVersionId} not found`,
      );
    }
    const arch = await ctx.architectureRepository.findById(version.architectureId);
    if (!arch || arch.projectId !== ctx.projectId) {
      throw new FeedbackConversionError(
        'FEEDBACK_ARCHITECTURE_VERSION_NOT_IN_PROJECT',
        `architecture version ${input.architectureVersionId} does not belong to project ${ctx.projectId}`,
      );
    }

    // --- the signal read through the WORK-067 PUBLIC service (fail closed).
    const signal = await ctx.engineeringSignalService.findSignal(input.signalId);
    if (!signal) {
      throw new FeedbackConversionError(
        'FEEDBACK_SIGNAL_NOT_FOUND',
        `Engineering Signal ${input.signalId} not found — a conversion requires its originating signal (fail closed; never an empty conclusion)`,
      );
    }
    if (signal.occurrences.length === 0) {
      throw new FeedbackConversionError(
        'FEEDBACK_SIGNAL_EMPTY',
        `Engineering Signal ${input.signalId} records no occurrences — a free-floating signal cannot be converted (fail closed)`,
      );
    }

    // --- the tenant/project scope assertions (mandatory boundaries).
    if (signal.tenantId !== ctx.tenantId) {
      throw new FeedbackConversionError(
        'FEEDBACK_SIGNAL_TENANT_MISMATCH',
        `signal ${input.signalId} belongs to tenant ${signal.tenantId} but the conversion scope is tenant ${ctx.tenantId} — tenant boundaries are mandatory`,
      );
    }
    if (signal.projectId !== ctx.projectId) {
      throw new FeedbackConversionError(
        'FEEDBACK_SIGNAL_PROJECT_MISMATCH',
        `signal ${input.signalId} belongs to project ${signal.projectId} but the conversion scope is project ${ctx.projectId} — project boundaries are mandatory`,
      );
    }

    // --- the deterministic conversion identity (tenant/project scoped).
    const identity = deriveConversionIdentity({
      tenantId: signal.tenantId,
      projectId: signal.projectId,
      logicalFailureKey: signal.logicalFailureKey,
    });

    // --- the existing backlog read through the EXISTING authority (the
    // dedup map + the assessment's only backlog evidence).
    const existingItems =
      await ctx.workItemRepository.findByArchitectureVersion(input.architectureVersionId);
    const backlogContext = deriveBacklogContext(existingItems);

    // --- the deterministic assessment.
    const assessment = assessSignal(signal, backlogContext);
    if (assessment.occurrenceCount !== signal.occurrences.length) {
      throw new FeedbackConversionError(
        'FEEDBACK_ASSESSMENT_INVALID',
        'the assessment did not preserve the signal occurrence count (internal invariant violation — fail closed)',
      );
    }

    // --- deduplication against existing Work Items (the deterministic key).
    const existingByKey = existingItems.find(
      (wi) => wi.workItemId === identity.conversionKey,
    );

    const decidedAt = this.now().toISOString();

    if (existingByKey && !existingByKey.completed) {
      // OPEN equivalent Work Item → 'deduplicated': converge on the existing
      // item, append this signal's provenance (append-only, through the
      // existing authority's public update path), record the decision.
      return this.convergeOnOpenItem(
        existingByKey,
        input.architectureVersionId,
        identity.conversionKey,
        signal,
        assessment,
        decidedAt,
        ctx,
      );
    }
    if (existingByKey && existingByKey.completed) {
      // COMPLETED equivalent Work Item in the SAME version → the logical
      // problem is observed AGAIN after completion: 'recurrence-recorded'.
      // NO create (the deterministic id is taken by the completed item —
      // the honest form), NO mutation of the completed item's evidence. The
      // decision records the recurrence; the architect/planner decides the
      // follow-up (a new version's conversion would create fresh work).
      return this.recordRecurrence(
        existingByKey,
        input.architectureVersionId,
        identity.conversionKey,
        signal,
        assessment,
        decidedAt,
        ctx,
      );
    }

    // --- no equivalent item → derive the priority and create the proposal
    // THROUGH the existing `/work-items` public intake.
    const priority = deriveConversionPriority(assessment, 1);

    const metadata: FeedbackConversionMetadata = {
      version: CONVERSION_VERSION,
      conversionKey: identity.conversionKey,
      identityFingerprint: identity.identityFingerprint,
      tenantId: signal.tenantId,
      projectId: signal.projectId,
      logicalFailureKey: signal.logicalFailureKey,
      contributingSignals: [
        {
          signalId: signal.signalId,
          identityFingerprint: signal.identityFingerprint,
          environmentId: signal.environmentId,
          latestSeverity: signal.latestSeverity,
          occurrenceCount: signal.occurrences.length,
          contributedAs: 'proposed',
          decidedAt,
        },
      ],
      decision: 'proposed',
      decidedAt,
      assessment: {
        latestSeverity: assessment.latestSeverity,
        occurrenceCount: assessment.occurrenceCount,
        environments: assessment.environments,
        sources: assessment.sources,
        reasoning: assessment.reasoning,
      },
      priority: {
        rank: priority.rank,
        rationale: priority.rationale,
        backlogRelation: priority.backlogRelation,
      },
      provenanceNote:
        'originates from an ADVISORY Engineering Signal conversion (WORK-067 → WORK-068); the proposal is planning input, never confirmed truth — the full governance lifecycle (architecture checkpoint, implementation, verification, architect review, merge) still applies before any code change',
    };

    try {
      const created = await ctx.workItemRepository.create({
        architectureVersionId: input.architectureVersionId,
        workItemId: identity.conversionKey,
        title: deriveProposalTitle(signal.logicalFailureKey),
        objective: deriveProposalObjective(
          signal.logicalFailureKey,
          signal.signalId,
          signal.latestSeverity,
          signal.occurrences.length,
        ),
        scope: `Environment scope at proposal time: ${signal.environmentId}. The logical problem is tenant/project scoped; the same logical failure across environments converges on this Work Item.`,
        metadata: { feedbackConversion: metadata },
        architectureImpact: deriveArchitectureImpact(signal.latestSeverity),
      });
      return this.buildResult(
        'proposed',
        input.architectureVersionId,
        identity.conversionKey,
        signal,
        assessment,
        priority,
        created,
        decidedAt,
        ctx,
        `the signal was assessed, deduplicated against the existing backlog (no open equivalent), prioritized, and proposed through the existing /work-items intake as Work Item ${created.workItemId}`,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A CONCURRENT conversion created the same deterministic key between
        // our backlog load and our insert → re-query → CONVERGE (the DB
        // constraint is the hard fence; application check-then-insert is
        // never the only guarantee — the planner precedent).
        const reloaded =
          await ctx.workItemRepository.findByArchitectureVersion(
            input.architectureVersionId,
          );
        const converged = reloaded.find(
          (wi) => wi.workItemId === identity.conversionKey,
        );
        if (converged && !converged.completed) {
          return this.convergeOnOpenItem(
            converged,
            input.architectureVersionId,
            identity.conversionKey,
            signal,
            assessment,
            decidedAt,
            ctx,
          );
        }
        if (converged && converged.completed) {
          return this.recordRecurrence(
            converged,
            input.architectureVersionId,
            identity.conversionKey,
            signal,
            assessment,
            decidedAt,
            ctx,
          );
        }
        // Unique-violation without a findable row — genuinely unexpected;
        // fall through to the typed intake failure (fail closed).
      }
      throw new FeedbackConversionError(
        'FEEDBACK_INTAKE_UNAVAILABLE',
        `the existing /work-items intake create failed for conversion key ${identity.conversionKey} (${err instanceof Error ? err.message : String(err)}) — nothing landed; the conversion is NOT silently retried and NEVER falls back to a second intake (fail closed)`,
      );
    }
  }

  async listConversions(
    projectId: string,
    ctx: Pick<FeedbackConversionContext, 'tenantId'>,
  ): Promise<readonly ConversionRecord[]> {
    // Read-only AND tenant-scoped: the tenant predicate is ENFORCED (never
    // accepted-and-ignored — the PR #107 architect-review secondary fix).
    // The caller's tenant scope decides which decision history is visible;
    // a cross-tenant caller never sees another tenant's records (a UUID is
    // never an authorization credential — the planner's scope discipline).
    const history = await this.recordRepository.listForProject(projectId);
    return history.filter((record) => record.tenantId === ctx.tenantId);
  }

  // -------------------------------------------------------------------------
  // The dedup-convergence path (open equivalent item)
  // -------------------------------------------------------------------------

  private async convergeOnOpenItem(
    existing: WorkItemRecord,
    architectureVersionId: string,
    conversionKey: string,
    signal: {
      signalId: string;
      identityFingerprint: string;
      environmentId: string;
      logicalFailureKey: string;
      latestSeverity: 'critical' | 'high' | 'medium' | 'low';
      occurrences: readonly unknown[];
      tenantId: string;
      projectId: string;
      sources: readonly string[];
      firstObservedAt: string;
      lastObservedAt: string;
    },
    assessment: ConversionAssessment,
    decidedAt: string,
    ctx: FeedbackConversionContext,
  ): Promise<ConversionResult> {
    // The contributing-signals append: preserve WHICH signals contributed to
    // the existing item (append-only — never removing/rewriting recorded
    // provenance), through the existing authority's public update path.
    const existingMetadata = readFeedbackMetadata(existing);
    const alreadyContributed = existingMetadata.contributingSignals.some(
      (cs) => cs.signalId === signal.signalId,
    );
    let workItemAfterAppend = existing;
    if (!alreadyContributed) {
      const contributing: ContributingSignal = {
        signalId: signal.signalId,
        identityFingerprint: signal.identityFingerprint,
        environmentId: signal.environmentId,
        latestSeverity: signal.latestSeverity,
        occurrenceCount: signal.occurrences.length,
        contributedAs: 'deduplicated',
        decidedAt,
      };
      const mergedMetadata: FeedbackConversionMetadata = {
        ...existingMetadata,
        contributingSignals: [...existingMetadata.contributingSignals, contributing],
      };
      const updated = await ctx.workItemRepository.update(existing.id, {
        metadata: { feedbackConversion: mergedMetadata },
      });
      if (updated) workItemAfterAppend = updated;
    }

    // The priority recomputed with the convergence breadth (the multi-
    // environment evidence from ALL contributing signals).
    const convergenceEnvironments = new Set(
      readFeedbackMetadata(workItemAfterAppend).contributingSignals.map(
        (cs) => cs.environmentId,
      ),
    );
    const priority = deriveConversionPriority(
      assessment,
      convergenceEnvironments.size,
    );

    return this.buildResult(
      'deduplicated',
      architectureVersionId,
      conversionKey,
      signal,
      assessment,
      priority,
      workItemAfterAppend,
      decidedAt,
      ctx,
      `an OPEN equivalent Work Item ${existing.workItemId} already exists for this logical problem (conversion key ${conversionKey}) — the signal converged on the existing item (provenance appended${alreadyContributed ? ' — already recorded, idempotent re-delivery' : ''}); NO second Work Item was created`,
    );
  }

  // -------------------------------------------------------------------------
  // The recurrence path (completed equivalent item in the same version)
  // -------------------------------------------------------------------------

  private async recordRecurrence(
    existing: WorkItemRecord,
    architectureVersionId: string,
    conversionKey: string,
    signal: {
      signalId: string;
      identityFingerprint: string;
      environmentId: string;
      logicalFailureKey: string;
      tenantId: string;
      projectId: string;
      sources: readonly string[];
      firstObservedAt: string;
      lastObservedAt: string;
      latestSeverity: 'critical' | 'high' | 'medium' | 'low';
      occurrences: readonly unknown[];
    },
    assessment: ConversionAssessment,
    decidedAt: string,
    ctx: FeedbackConversionContext,
  ): Promise<ConversionResult> {
    const priority = deriveConversionPriority(assessment, 1);
    return this.buildResult(
      'recurrence-recorded',
      architectureVersionId,
      conversionKey,
      signal,
      assessment,
      priority,
      existing,
      decidedAt,
      ctx,
      `the logical problem (conversion key ${conversionKey}) was COMPLETED in Work Item ${existing.workItemId} within this architecture version, but the signal observes it AGAIN — the recurrence is RECORDED (not silently converted, not silently dismissed); the deterministic id remains stable, so a NEW architecture version's conversion will propose fresh governed work; the architect/planner owns the follow-up decision`,
    );
  }

  // -------------------------------------------------------------------------
  // The shared result/record builder
  // -------------------------------------------------------------------------

  private async buildResult(
    decision: 'proposed' | 'deduplicated' | 'recurrence-recorded',
    architectureVersionId: string,
    conversionKey: string,
    signal: {
      signalId: string;
      identityFingerprint: string;
      environmentId: string;
      logicalFailureKey: string;
      tenantId: string;
      projectId: string;
    },
    assessment: ConversionAssessment,
    priority: ConversionPriority,
    workItem: WorkItemRecord | null,
    decidedAt: string,
    _ctx: FeedbackConversionContext,
    reasoning: string,
  ): Promise<ConversionResult> {
    // The decision-record identity is scoped by the architecture version —
    // the record-side mirror of the UNIQUE(architecture_version_id,
    // work_item_id) fence: the same logical problem under TWO versions is
    // TWO governed Work Items and TWO independent decision records, each
    // referencing ITS OWN version's Work Item (the PR #107 architect-review
    // fix — the returned result can never point at version B's Work Item
    // while its record still references version A's).
    const record: ConversionRecord = {
      recordId: deriveConversionRecordId(
        conversionKey,
        architectureVersionId,
        signal.signalId,
        decision,
      ),
      conversionKey,
      architectureVersionId,
      tenantId: signal.tenantId,
      projectId: signal.projectId,
      signalId: signal.signalId,
      decision,
      workItemId: workItem?.id ?? null,
      workItemHumanId: workItem?.workItemId ?? null,
      decidedAt,
      summary: `signal ${signal.signalId} (${signal.logicalFailureKey}) → ${decision}${workItem ? ` on Work Item ${workItem.workItemId}` : ''} at ${decidedAt}; tenant ${signal.tenantId}, project ${signal.projectId}, architecture version ${architectureVersionId}`,
    };
    const stored = await this.recordRepository.append(record);
    return {
      decision,
      conversionKey,
      signal: {
        signalId: signal.signalId,
        identityFingerprint: signal.identityFingerprint,
        logicalFailureKey: signal.logicalFailureKey,
        environmentId: signal.environmentId,
      },
      assessment,
      priority,
      workItem: workItem
        ? {
            id: workItem.id,
            workItemId: workItem.workItemId,
            title: workItem.title,
            completed: workItem.completed,
          }
        : null,
      reasoning,
      record: stored,
    };
  }
}

/** Read the feedbackConversion metadata payload off an authoritative Work Item. */
function readFeedbackMetadata(item: WorkItemRecord): FeedbackConversionMetadata {
  const raw = (item.metadata as { feedbackConversion?: unknown })?.feedbackConversion;
  if (!raw || typeof raw !== 'object') {
    // An item carrying the conversion key WITHOUT the payload — an identity
    // conflict (someone created a SIGWI-* item outside the conversion; the
    // provenance chain cannot be reconstructed). Fail closed.
    throw new FeedbackConversionError(
      'FEEDBACK_CONVERSION_IDENTITY_CONFLICT',
      `Work Item ${item.workItemId} carries the conversion key but no feedbackConversion provenance payload — the provenance chain cannot be reconstructed (fail closed)`,
    );
  }
  const metadata = raw as FeedbackConversionMetadata;
  if (
    !Array.isArray(metadata.contributingSignals) ||
    metadata.contributingSignals.length === 0
  ) {
    throw new FeedbackConversionError(
      'FEEDBACK_CONVERSION_IDENTITY_CONFLICT',
      `Work Item ${item.workItemId} carries a feedbackConversion payload without contributing signals — free-floating provenance is invalid (fail closed)`,
    );
  }
  return metadata;
}

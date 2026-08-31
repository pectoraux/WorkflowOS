/**
 * WORK-068 — Feedback → Governed Work Items: the domain contract.
 *
 * THE CONVERSION LAYER (not a second authority). This domain turns WORK-067
 * advisory Engineering Signals into PROPOSED governed Work Items that enter
 * the EXISTING `/work-items` authority through its existing public intake
 * (`WorkItemRepository.create` — the single creation path, the WORK-040
 * development-planner precedent). It owns assessment, deduplication against
 * existing open Work Items, conversion-relative priority, and provenance from
 * the proposed Work Item back to its originating signal(s).
 *
 * It NEVER owns: Engineering Signal correlation (WORK-067), signal intake
 * taxonomy (future WORK-056), validation semantics (WORK-064), browser
 * execution (WORK-065), scheduling (WORK-066), the Work Item authority itself
 * (`/work-items`), workflow transitions (`/workflows`), continuous planning
 * (WORK-040), progressive release (WORK-069), architecture fitness
 * (WORK-070), code mutation, PR creation/merge, verification, review, or any
 * autonomous background process. The conversion happens ONLY through an
 * explicit governed invocation (`FeedbackConversionService.convertSignal`).
 *
 * Traceability chain (invariant 3 — reconstructable end to end):
 *   observation → engineering signal (WORK-067) → assessment →
 *   conversion decision → EXISTING Work Item (`/work-items`)
 */

// ============================================================================
// §1  Closed vocabularies
// ============================================================================

/** The conversion decision outcomes (closed vocabulary). */
export const CONVERSION_DECISION_STATUSES = [
  'proposed',
  'deduplicated',
  'recurrence-recorded',
] as const;
export type ConversionDecisionStatus = (typeof CONVERSION_DECISION_STATUSES)[number];

/**
 * The conversion-relative priority ranks (closed vocabulary). CRITICAL
 * ARCHITECTURAL RULE (invariant 5): this is RELATIVE CONVERSION PRIORITY for
 * PROPOSED work only — an explainable ranking attached to the proposal. It
 * is NOT a backlog ordering engine, NOT a scheduling input, and NOT a
 * replacement for the WORK-040 continuous development planner (the ONE
 * planning authority).
 */
export const CONVERSION_PRIORITY_RANKS = ['P0', 'P1', 'P2', 'P3'] as const;
export type ConversionPriorityRank = (typeof CONVERSION_PRIORITY_RANKS)[number];

/** The discrete, explainable assessment factor kinds (closed vocabulary). */
export const CONVERSION_FACTOR_KINDS = [
  'signal-severity',
  'recurrence',
  'blast-radius-environments',
  'blast-radius-sources',
  'multi-environment-convergence',
  'backlog-context',
] as const;
export type ConversionFactorKind = (typeof CONVERSION_FACTOR_KINDS)[number];

/** The typed failure codes (fail closed — never silent healthy). */
export const FEEDBACK_CONVERSION_ERROR_CODES = [
  'FEEDBACK_SIGNAL_NOT_FOUND',
  'FEEDBACK_SIGNAL_EMPTY',
  'FEEDBACK_SIGNAL_TENANT_MISMATCH',
  'FEEDBACK_SIGNAL_PROJECT_MISMATCH',
  'FEEDBACK_ARCHITECTURE_VERSION_NOT_FOUND',
  'FEEDBACK_ARCHITECTURE_VERSION_NOT_IN_PROJECT',
  'FEEDBACK_ASSESSMENT_INVALID',
  'FEEDBACK_INTAKE_UNAVAILABLE',
  'FEEDBACK_CONVERSION_IDENTITY_CONFLICT',
  'FEEDBACK_CONVERSION_RECORD_CONFLICT',
] as const;
export type FeedbackConversionErrorCode = (typeof FEEDBACK_CONVERSION_ERROR_CODES)[number];

// ============================================================================
// §2  The deterministic conversion identity (the dedup matching key)
// ============================================================================

/** The identity inputs — TENANT/PROJECT scoped (invariant: mandatory boundaries). */
export interface ConversionIdentityInput {
  readonly tenantId: string;
  readonly projectId: string;
  /**
   * The logical failure key of the Engineering Signal (WORK-067's
   * problem-domain identifier). The SAME logical failure across DIFFERENT
   * environments is ONE engineering problem: the environment participates in
   * the signal identity (WORK-067) and in the assessment's blast radius —
   * never in the work-item conversion identity.
   */
  readonly logicalFailureKey: string;
}

/** The derived deterministic conversion identity (pure — sha256 over canonical fields). */
export interface ConversionIdentity {
  /**
   * `SIGWI-<24 hex>` — the deterministic proposed Work Item id (the dedup
   * key against existing Work Items in the target architecture version; the
   * existing UNIQUE(architecture_version_id, work_item_id) DB constraint is
   * the persistence-level fence — the WORK-040 planner precedent).
   */
  readonly conversionKey: string;
  /**
   * The identity content fingerprint (sha256 over ALL identity fields). Two
   * conversions with the same fingerprint converge; the same conversionKey
   * with a different fingerprint is a typed identity conflict.
   */
  readonly identityFingerprint: string;
}

// ============================================================================
// §3  The assessment (deterministic, explainable — no invented evidence)
// ============================================================================

/**
 * A discrete, explainable assessment factor. Every factor is DERIVED from
 * the signal's recorded evidence (the WORK-067 record) or the existing
 * backlog state read through the authority — never manufactured from
 * timestamps, commits, URLs, GitHub state, or undocumented heuristics.
 */
export interface ConversionFactor {
  readonly kind: ConversionFactorKind;
  /** The deterministic evidence the factor is derived from (human-readable). */
  readonly detail: string;
}

/**
 * The deterministic conversion assessment of ONE Engineering Signal against
 * the existing backlog. Interprets (never invents): severity, scope/blast
 * radius, recurrence, and the affected tenant/project/environment.
 */
export interface ConversionAssessment {
  /** The assessed signal (the WORK-067 record reference — preserved exactly). */
  readonly signalId: string;
  readonly signalFingerprint: string;
  readonly tenantId: string;
  readonly projectId: string;
  /** The DISTINCT environments the signal's occurrences span (blast radius). */
  readonly environments: readonly string[];
  /** The DISTINCT sources of the signal's occurrences. */
  readonly sources: readonly string[];
  readonly occurrenceCount: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  /** The severity of the LATEST occurrence (WORK-067's deterministic ordering). */
  readonly latestSeverity: 'critical' | 'high' | 'medium' | 'low';
  /** The severity interpretation for conversion purposes (deterministic mapping). */
  readonly severityInterpretation: string;
  /**
   * The observed recurrence span (ISO-8601 duration between the first and
   * last observation — recorded evidence, never extrapolated).
   */
  readonly recurrenceSpan: string;
  /** The existing backlog state at assessment time (read through the authority). */
  readonly backlogContext: BacklogContext;
  /** The discrete explainable factors backing the assessment. */
  readonly factors: readonly ConversionFactor[];
  /** Structured reasoning sufficient for a reviewer to understand the decision. */
  readonly reasoning: string;
}

/**
 * The existing backlog state (read through the existing `/work-items`
 * authority — the assessment's ONLY backlog evidence; never fabricated).
 */
export interface BacklogContext {
  /** Open (not completed) Work Items in the target architecture version. */
  readonly openItemCount: number;
  readonly completedItemCount: number;
  /** Open items grouped by their metadata.feedbackConversion severity, when present. */
  readonly openConversionSeverities: Readonly<Record<string, number>>;
}

// ============================================================================
// §4  The conversion-relative priority (invariant 5 — never a planning engine)
// ============================================================================

/**
 * The conversion-relative priority of a proposal. Explainable and discrete:
 * the rank derivation is deterministic from the assessment factors, and the
 * backlog relation states where the proposal stands RELATIVE to the existing
 * open backlog — it NEVER reorders the backlog, NEVER assigns scheduling,
 * and NEVER replaces the WORK-040 planner.
 */
export interface ConversionPriority {
  readonly rank: ConversionPriorityRank;
  readonly factors: readonly ConversionFactor[];
  readonly rationale: string;
  /**
   * The relative statement (e.g. "ranks ahead of 3 of 5 open Work Items by
   * conversion severity ordering") — explanatory only.
   */
  readonly backlogRelation: string;
}

// ============================================================================
// §5  Provenance + the embedded metadata payload (invariant 3)
// ============================================================================

/** One contributing signal's provenance record (append-only). */
export interface ContributingSignal {
  readonly signalId: string;
  readonly identityFingerprint: string;
  readonly environmentId: string;
  readonly latestSeverity: 'critical' | 'high' | 'medium' | 'low';
  readonly occurrenceCount: number;
  /** How this signal contributed: the decision recorded for ITS conversion. */
  readonly contributedAs: ConversionDecisionStatus;
  readonly decidedAt: string;
}

/**
 * The provenance payload embedded in the created Work Item's
 * `metadata.feedbackConversion` (the planner's `metadata.planner` precedent
 * — NO new column, NO new table). Preserves the full chain:
 * signal → assessment → decision → the EXISTING Work Item.
 */
export interface FeedbackConversionMetadata {
  readonly version: string;
  readonly conversionKey: string;
  readonly identityFingerprint: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalFailureKey: string;
  /** EVERY signal that contributed to this Work Item (append-only). */
  readonly contributingSignals: readonly ContributingSignal[];
  /** The initial decision that created the Work Item ('proposed'). */
  readonly decision: ConversionDecisionStatus;
  readonly decidedAt: string;
  /** The assessment summary (the deterministic reasoning, preserved). */
  readonly assessment: {
    readonly latestSeverity: 'critical' | 'high' | 'medium' | 'low';
    readonly occurrenceCount: number;
    readonly environments: readonly string[];
    readonly sources: readonly string[];
    readonly reasoning: string;
  };
  /** The conversion-relative priority (explanatory, never a planning engine). */
  readonly priority: {
    readonly rank: ConversionPriorityRank;
    readonly rationale: string;
    readonly backlogRelation: string;
  };
  /**
   * The governed declaration: this Work Item originates from an ADVISORY
   * Engineering Signal conversion — the proposal is planning input, never
   * confirmed truth (the planner's honest-provenance discipline).
   */
  readonly provenanceNote: string;
}

// ============================================================================
// §6  The conversion decision record (the append-only log)
// ============================================================================

/**
 * ONE conversion decision (append-only). The decision log preserves the full
 * history of which signals were converted/deduplicated/recurrence-recorded,
 * when, and why — the deterministic explanation of why a signal did or did
 * not become a proposed Work Item.
 */
export interface ConversionRecord {
  /**
   * Deterministic over (conversionKey, architectureVersionId, signalId,
   * decision): the same logical problem + the same architecture version +
   * the same signal + the same decision is ONE record identity
   * (re-delivery converges on the existing record — the keyed uniqueness
   * contract of the record port). The DECISION participates so the
   * append-only log preserves the honest decision history of a signal
   * ('proposed' at first conversion, 'deduplicated' once an open
   * equivalent exists) without ever rewriting a stored record.
   *
   * ARCHITECTURE VERSION participates because the authoritative Work Item
   * dedup fence is UNIQUE(architecture_version_id, work_item_id): the SAME
   * logical problem converted under TWO architecture versions creates TWO
   * governed Work Items, and each decision record must reference ITS OWN
   * version's Work Item — a record identity without the version dimension
   * would collide across versions and point one version's decision at the
   * other version's Work Item (the PR #107 architect-review blocker: the
   * returned ConversionResult must never reference Work Item B while its
   * decision record still references Work Item A).
   */
  readonly recordId: string;
  readonly conversionKey: string;
  /** The architecture version the decision was recorded against (the record-side scope of the UNIQUE(architecture_version_id, work_item_id) fence). */
  readonly architectureVersionId: string;
  /** The tenant/project scope the decision was recorded under. */
  readonly tenantId: string;
  readonly projectId: string;
  readonly signalId: string;
  readonly decision: ConversionDecisionStatus;
  /** The authoritative Work Item the decision references (when one exists). */
  readonly workItemId: string | null;
  readonly workItemHumanId: string | null;
  readonly decidedAt: string;
  /** The structured summary (the deterministic explanation). */
  readonly summary: string;
}

// ============================================================================
// §7  The persistence port (the decision-log boundary — NO migration)
// ============================================================================

/**
 * The persistence port for conversion decision records.
 *
 * ARCHITECTURAL RULING (the WORK-064 run-repository / WORK-066 claim-store /
 * WORK-067 signal-repository precedent): WORK-068's parallel-execution
 * metadata declares `migrations: []` — NO schema migration is authorized.
 * The in-memory adapter is the composed implementation; the AUTHORITATIVE
 * Work Item state lives in the EXISTING `wfos_work_items` table (created
 * through the existing intake). The durable decision-log binding point is a
 * documented future ACR at this same port.
 */
export interface FeedbackConversionRecordRepository {
  /**
   * Append a decision record. Idempotent on recordId (the deterministic
   * (conversionKey, architectureVersionId, signalId, decision) key):
   * appending the same record identity again converges on the stored record
   * (re-delivery never duplicates the log). A recordId collision with a
   * DIFFERENT decision payload is a typed conflict (fail closed — never
   * silently overwritten). Records under DIFFERENT architecture versions
   * are INDEPENDENT identities (they never collide and never converge).
   */
  append(record: ConversionRecord): Promise<ConversionRecord>;
  /** The decision history for one conversion key (chronological). */
  listForConversion(conversionKey: string): Promise<readonly ConversionRecord[]>;
  /** The decision history for one project (read-only). */
  listForProject(projectId: string): Promise<readonly ConversionRecord[]>;
}

// ============================================================================
// §8  The service contract (the explicit governed invocation)
// ============================================================================

/** The conversion request — ONE signal, ONE explicit invocation. */
export interface ConvertSignalInput {
  readonly signalId: string;
  /** The target architecture version the proposed Work Item enters. */
  readonly architectureVersionId: string;
}

/**
 * The server-side scope + authority handles. Constructed by the composition
 * root (app.ts) or the test harness — a UUID is NEVER an authorization
 * credential; the caller's tenant/project scope is asserted BEFORE any read.
 */
export interface FeedbackConversionContext {
  readonly tenantId: string;
  readonly projectId: string;
  /** WORK-067 consumed through its PUBLIC barrel (never internals). */
  readonly engineeringSignalService: EngineeringSignalReader;
  /** `/work-items` consumed through its PUBLIC barrel (never internals). */
  readonly workItemRepository: WorkItemIntake;
  readonly architectureVersionRepository: ArchitectureVersionReader;
  readonly architectureRepository: ArchitectureReader;
}

/**
 * The WORK-067 public surface WORK-068 consumes (the read-only subset the
 * conversion needs — the shapes match the public `EngineeringSignal` record).
 */
export interface EngineeringSignalReader {
  findSignal(signalId: string): Promise<EngineeringSignalRecord | null>;
}

/** The WORK-067 `EngineeringSignal` record shape (consumed, never redefined). */
export interface EngineeringSignalRecord {
  readonly signalId: string;
  readonly identityFingerprint: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly logicalFailureKey: string;
  readonly sources: readonly string[];
  readonly occurrences: readonly {
    readonly observedAt: string;
    readonly severity: 'critical' | 'high' | 'medium' | 'low';
  }[];
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly latestSeverity: 'critical' | 'high' | 'medium' | 'low';
}

/** The `/work-items` public intake subset (from the public barrel types). */
export interface WorkItemIntake {
  create(input: {
    architectureVersionId: string;
    workItemId: string;
    title: string;
    objective?: string;
    scope?: string;
    metadata?: Record<string, unknown>;
    architectureImpact?: 'low' | 'medium' | 'high' | null;
  }): Promise<WorkItemRecord>;
  findByArchitectureVersion(architectureVersionId: string): Promise<WorkItemRecord[]>;
  update(
    id: string,
    input: { metadata?: Record<string, unknown> },
  ): Promise<WorkItemRecord | null>;
}

/** The authoritative Work Item record (the `/work-items` public shape — consumed, never redefined). */
export interface WorkItemRecord {
  readonly id: string;
  readonly workItemId: string;
  readonly title: string;
  readonly completed: boolean;
  readonly metadata: Record<string, unknown>;
}

/** The architecture-version scope readers (the planner's defense-in-depth precedent). */
export interface ArchitectureVersionReader {
  findById(id: string): Promise<{ architectureId: string } | null>;
}
export interface ArchitectureReader {
  findById(id: string): Promise<{ projectId: string } | null>;
}

/** The structured conversion result. */
export interface ConversionResult {
  readonly decision: ConversionDecisionStatus;
  readonly conversionKey: string;
  /** The assessed signal reference (preserved exactly). */
  readonly signal: {
    readonly signalId: string;
    readonly identityFingerprint: string;
    readonly logicalFailureKey: string;
    readonly environmentId: string;
  };
  readonly assessment: ConversionAssessment;
  readonly priority: ConversionPriority;
  /** The authoritative Work Item the decision references. */
  readonly workItem:
    | {
        readonly id: string;
        readonly workItemId: string;
        readonly title: string;
        readonly completed: boolean;
      }
    | null;
  /** The deterministic explanation of the decision. */
  readonly reasoning: string;
  /** The appended decision record. */
  readonly record: ConversionRecord;
}

/** The service contract — ONE explicit governed conversion entry point + reads. */
export interface FeedbackConversionService {
  /**
   * Convert ONE Engineering Signal into a governed Work Item proposal
   * through the canonical flow: signal → assessment → deduplication →
   * priority → proposal → the EXISTING `/work-items` intake. NEVER
   * autonomous: each conversion is an explicit governed invocation.
   */
  convertSignal(
    input: ConvertSignalInput,
    ctx: FeedbackConversionContext,
  ): Promise<ConversionResult>;
  /**
   * Read the conversion decision history for a project (read-only,
   * tenant-scoped: only the caller tenant's decision records are returned —
   * the tenant predicate is ENFORCED, never accepted-and-ignored; a
   * cross-tenant caller never sees another tenant's decision history).
   */
  listConversions(
    projectId: string,
    ctx: Pick<FeedbackConversionContext, 'tenantId'>,
  ): Promise<readonly ConversionRecord[]>;
}

// ============================================================================
// §9  The typed error (fail closed — never a silent healthy)
// ============================================================================

/** The typed conversion failure. Codes are closed; failures are never swallowed. */
export class FeedbackConversionError extends Error {
  readonly code: FeedbackConversionErrorCode;
  constructor(code: FeedbackConversionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FeedbackConversionError';
    this.code = code;
  }
}

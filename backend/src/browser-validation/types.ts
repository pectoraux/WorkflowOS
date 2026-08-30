/**
 * WORK-065 — Synthetic Browser Validation Agent: the public contracts.
 *
 * The browser validation agent lives at `src/browser-validation/` (application-
 * layer capability OUTSIDE src/modules/, mirroring the §34 benchmark /
 * execution-policy / orchestration / agent-roles / continuous-validation
 * pattern — NOT an 18th frozen module). It is the EXECUTION MECHANISM for
 * ValidationJourneys declared under WORK-064's authority:
 *
 *   WORK-064 (Continuous Product Validation) — the domain/model authority
 *       ↓ declares ValidationJourney / EffectPolicy / TestIdentity /
 *         Environment / ExpectedObservation / Evidence
 *   WORK-065 (this domain) — the synthetic browser execution mechanism
 *       ↓ executes under the declared EffectPolicy (enforced at execution
 *         time — fail closed on every forbidden or out-of-policy action)
 *       ↓ observes into the EXISTING /verification authority (evidence is
 *         mapped through its public attachEvidence boundary, never
 *         duplicated)
 *
 * BOUNDARY CONTRACT (spec/work-orders/WORK-065.md +
 * spec/architecture/v1.1/validation-model.md §9 — enforced by static-
 * architecture checks):
 *
 *   - NOT a second verification authority: the agent produces observations,
 *     never verdicts. Health is derived by the WORK-064 finalization
 *     boundary; the agent's asserted `matched` is verified, never trusted.
 *   - NOT a second execution authority: the agent is a tool-runtime
 *     consumer underneath the existing execution boundary (the BrowserDriver
 *     port — WORK-036's neutral navigation/inspection port).
 *   - NOT a second workflow authority: the agent does not transition Work
 *     Items, does not create PRs, does not merge, does not approve reviews.
 *   - NOT a code-mutation authority: the agent observes; it never modifies
 *     code because it found a failure.
 *   - NOT a production destructive surface: uncontrolled destructive side
 *     effects are rejected by EffectPolicy enforcement at execution time.
 *   - NOT a second identity authority: the TestIdentity is PRESENTED to the
 *     WORK-064 admission boundary (an already-authenticated principal); the
 *     agent never mints credentials, never creates users, never impersonates
 *     a human.
 *   - NOT a scheduler: no timers, no queues, no autonomous loops. WORK-066
 *     owns triggers.
 *   - NO second browser automation framework: the agent consumes the
 *     EXISTING BrowserDriver port (WORK-036). The Playwright-backed driver
 *     adapter is the ONE place browser-automation libraries appear (the
 *     explicit boundary).
 *
 * v1.0 remains frozen; this is v1.1-proposed runtime under WORK-065.
 */
import type {
  Environment,
  TestIdentitySource,
  ValidationJourney,
  ValidationMode,
  ValidationRun,
  ValidationTrigger,
} from '../continuous-validation/types.js';
import type { ValidationEvidenceReference } from '../continuous-validation/internal/evidence-mapping.js';

// ============================================================================
// §1  The browser action vocabulary (the execution contract)
// ============================================================================

/**
 * The closed action vocabulary the browser agent performs. Each action maps
 * to a {@link BrowserDriver} primitive (WORK-036's neutral port) and carries
 * an effect classification (read vs. mutation) the agent enforces against
 * the run's declared {@link EffectPolicy} BEFORE execution.
 *
 * An action may declare the expected observation it satisfies
 * ({@link BrowserAction.satisfiesObservationId}) — the agent captures the
 * action's result as a `ValidationObservation` bound to that expectation's id
 * with the full run→journey→step→environment→time provenance chain.
 */
export type BrowserAction =
  | {
      readonly kind: 'navigate';
      /** An absolute http(s) URL (the driver enforces the scheme). */
      readonly url: string;
      /** The expected observation this navigation satisfies (a network status_code expectation). */
      readonly satisfiesObservationId?: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: 'click';
      readonly selector: string;
      readonly satisfiesObservationId?: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: 'type';
      readonly selector: string;
      readonly text: string;
      readonly satisfiesObservationId?: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: 'extract';
      readonly selector: string;
      /**
       * REQUIRED for extract: the expected DOM observation this extraction
       * satisfies (a contains_text / equals / exists expectation). An
       * extraction without a satisfying observation is meaningless (it
       * observes nothing the journey declared).
       */
      readonly satisfiesObservationId: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: 'screenshot';
      readonly satisfiesObservationId?: string;
      readonly timeoutMs?: number;
    };

/** The effect classification of a browser action (the enforcement input). */
export type BrowserActionEffect = 'read' | 'mutation';

// ============================================================================
// §2  The browser journey plan (the execution plan derived from a journey)
// ============================================================================

/**
 * One step of the browser journey plan. The `stepId` MUST match a step
 * declared in the {@link ValidationJourney} (validated at plan construction).
 * The ordered `actions` are the browser primitives the agent performs; each
 * action may satisfy one of the step's expected observations.
 */
export interface BrowserPlanStep {
  readonly stepId: string;
  readonly actions: readonly BrowserAction[];
}

/**
 * The execution plan for a {@link ValidationJourney}: the ordered browser
 * steps the agent performs. Every `satisfiesObservationId` referenced by an
 * action MUST be a declared expected observation in the journey (validated
 * at plan construction — a plan referencing an unknown observation is
 * rejected). A plan that satisfies NO expected observation is rejected (the
 * agent observes nothing the journey declared — health would be vacuous).
 */
export interface BrowserJourneyPlan {
  readonly journeyId: string;
  readonly steps: readonly BrowserPlanStep[];
}

// ============================================================================
// §3  The browser validation agent (the execution mechanism contract)
// ============================================================================

/** The input to {@link BrowserValidationAgent.executeValidationRun}. */
export interface ExecuteValidationRunInput {
  /** The ValidationJourney declared under WORK-064's authority. */
  readonly journey: ValidationJourney;
  /**
   * The synthetic (or unauthenticated) identity source. PRESENTED to the
   * WORK-064 admission boundary — the agent never mints, never impersonates.
   */
  readonly identitySource: TestIdentitySource;
  /** The target Environment (its acceptedPolicies bind the EffectPolicy). */
  readonly environment: Environment;
  readonly mode: ValidationMode;
  readonly trigger: ValidationTrigger;
  /** REQUIRED for POST_RELEASE; recorded for the future release authority. */
  readonly releaseRef?: string;
  /** REQUIRED for CONTINUOUS (no autonomous scheduling — WORK-066 owns triggers). */
  readonly continuousConfigured?: boolean;
  /** The execution plan (browser actions per step). */
  readonly plan: BrowserJourneyPlan;
  /** The EXISTING /verification run id (the agent never creates verification runs). */
  readonly verificationRunId: string;
  /** The project whose verification run this evidence attaches to. */
  readonly projectId: string;
  /** Deterministic run id for tests; generated when absent. */
  readonly runId?: string;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * The outcome of a browser validation execution. The agent NEVER fabricates a
 * run: a rejected admission returns `admission` with `run: null` and NO
 * evidence reference; an executed run returns `run` (completed) + the
 * evidence reference (when mapping succeeded). A browser/environment failure
 * returns a completed run whose outcome is `environment_error`; a policy
 * violation returns a completed run whose outcome is `effect_policy_violation`;
 * a missing observation returns a completed run whose outcome is
 * `validation_failure`. NEVER healthy by default.
 */
export interface BrowserValidationOutcome {
  /** The WORK-064 admission decision (rejected admissions carry no run). */
  readonly admitted: boolean;
  readonly admissionReason: string;
  /** The admitted run (null when admission was rejected). */
  readonly run: ValidationRun | null;
  /**
   * The /verification evidence reference (null when admission was rejected
   * OR when the run was not mapped into /verification — e.g., the caller
   * supplied no verificationRunId, which is a typed rejection).
   */
  readonly evidenceReference: ValidationEvidenceReference | null;
}

// ============================================================================
// §4  The typed domain error
// ============================================================================

export const BROWSER_VALIDATION_ERROR_CODES = [
  // Plan construction
  'BROWSER_PLAN_INVALID',
  'BROWSER_PLAN_FOREIGN_OBSERVATION',
  'BROWSER_PLAN_SATISFIES_NOTHING',
  // Execution
  'BROWSER_DRIVER_UNAVAILABLE',
  'BROWSER_VALIDATION_NOT_MAPPED',
] as const;
export type BrowserValidationErrorCode = (typeof BROWSER_VALIDATION_ERROR_CODES)[number];

/**
 * The typed browser-validation error. Discriminated by `code`. The agent
 * throws this for structural violations (a malformed plan, an unmapped run).
 * Runtime execution failures (driver unavailable, timeout, selector miss)
 * are NOT thrown — they become typed outcomes (environment_error /
 * validation_failure) preserved with full provenance.
 */
export class BrowserValidationError extends Error {
  readonly code: BrowserValidationErrorCode;

  constructor(code: BrowserValidationErrorCode, message: string) {
    super(`browser-validation: ${message}`);
    this.name = 'BrowserValidationError';
    this.code = code;
  }
}

// ============================================================================
// §5  The agent contract (the execution mechanism, not an authority)
// ============================================================================

/**
 * The synthetic browser validation agent — the EXECUTION MECHANISM for
 * ValidationJourneys. It is NOT an authority:
 *
 *   - it CONSUMES the WORK-064 ContinuousValidationService for admission,
 *     finalization, and evidence mapping (never reimplements them);
 *   - it CONSUMES the existing BrowserDriver port (WORK-036 — the neutral
 *     navigation/inspection port; NO second browser framework);
 *   - it enforces the declared EffectPolicy at execution time (before every
 *     action) and fail-closes on every forbidden or out-of-policy action;
 *   - it captures observations with the full run→journey→step→environment→
 *     time provenance chain;
 *   - it maps the completed run's outcome into the EXISTING /verification
 *     authority through its public attachEvidence boundary.
 *
 * The agent never mutates code, merges PRs, approves reviews, or transitions
 * workflow state (static-architecture invariant).
 */
export interface BrowserValidationAgent {
  /**
   * Execute a validation run: admit (WORK-064) → enforce EffectPolicy →
   * perform the declared journey → capture observations → finalize (WORK-064)
   * → map into /verification. Returns the typed outcome (never a silent
   * healthy). A rejected admission returns `admitted: false` with `run: null`.
   */
  executeValidationRun(input: ExecuteValidationRunInput): Promise<BrowserValidationOutcome>;
}

// ============================================================================
// §6  Re-exports of the consumed authority types (single import surface)
// ============================================================================

export type {
  EffectPolicy,
  Environment,
  TestIdentitySource,
  ValidationJourney,
  ValidationMode,
  ValidationRun,
  ValidationTrigger,
} from '../continuous-validation/types.js';

export type { BrowserDriver } from '@platform/tools/browser-tool-executor.js';

export type {
  BrowserDriverCallOptions,
  BrowserNavigationResult,
  BrowserActionResult,
  BrowserExtractionResult,
  BrowserScreenshotResult,
} from '@platform/tools/browser-tool-executor.js';

// Re-export the ContinuousValidationService contract so consumers depend on
// ONE surface (the browser agent's barrel). The agent does NOT own this type
// — it consumes it.
export type { ContinuousValidationService } from '../continuous-validation/internal/continuous-validation-service.js';

// Re-export the /verification evidence reference type (produced by the
// WORK-064 evidence-mapping boundary the agent calls).
export type { ValidationEvidenceReference } from '../continuous-validation/internal/evidence-mapping.js';

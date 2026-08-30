/**
 * WORK-064 Task 6b — the typed outcome finalization with full provenance.
 *
 * THE INVARIANT (spec/work-orders/WORK-064.md invariant 6 + required proof
 * 5; evidence-provenance-model §5): a validation failure is never silently
 * discarded, never converted into a false healthy state, and never directly
 * converted into an ungoverned code change.
 *
 * Finalization derives the typed outcome deterministically:
 *
 *   executionError → effect_policy_violation | environment_error (typed,
 *                    provenance preserved — never healthy);
 *   otherwise      → every journey expectation must have a MATCHED result;
 *                    any missing or unmatched expectation is an explicit
 *                    validation_failure record (actual: null for missing);
 *   healthy        → ONLY when every expectation matched AND therefore every
 *                    declared success criterion is satisfied.
 *
 * There is NO code path from an absent/invalid observation to `healthy`.
 */
import type {
  ExecutionError,
  ExpectedObservation,
  ObservationProvenance,
  ObservationResult,
  ValidationFailure,
  ValidationJourney,
  ValidationObservation,
  ValidationOutcome,
  ValidationRun,
} from '../types.js';
import { ValidationDomainError } from '../types.js';

/** The finalization input. */
export interface FinalizeValidationRunInput {
  /** The ADMITTED run being finalized. */
  readonly run: ValidationRun;
  /** The journey the run executes (must match run.journeyId). */
  readonly journey: ValidationJourney;
  /** The evaluated observation results (must reference the journey's expectations). */
  readonly results: readonly ObservationResult[];
  /** An execution-level error reported by the executor, if any. */
  readonly executionError?: ExecutionError;
  /** Deterministic completion timestamp for tests. */
  readonly completedAt?: string;
}

/** Every expected observation of the journey, keyed by id. */
function journeyExpectations(journey: ValidationJourney): Map<string, ExpectedObservation> {
  const expectations = new Map<string, ExpectedObservation>();
  for (const step of journey.steps) {
    for (const expected of step.expectedObservations) {
      expectations.set(expected.id, expected);
    }
  }
  return expectations;
}

/**
 * Finalize a validation run: derive the typed outcome, preserve every
 * failure with full provenance, and return the immutable completed run.
 * Throws a typed {@link ValidationDomainError} on structural violations
 * (already-completed run, journey mismatch, foreign results, duplicated
 * results, provenance mismatch, invalid executionError).
 */
export function finalizeValidationRun(input: FinalizeValidationRunInput): ValidationRun {
  const { run, journey, results } = input;

  if (run.status !== 'admitted') {
    throw new ValidationDomainError(
      'FINALIZE_RUN_ALREADY_COMPLETED',
      `run ${run.id} is already ${run.status} — a run is finalized exactly once`,
    );
  }
  if (journey.id !== run.journeyId) {
    throw new ValidationDomainError(
      'FINALIZE_JOURNEY_MISMATCH',
      `the journey ${journey.id} does not match the run's journey ${run.journeyId}`,
    );
  }

  // Validate the results: every result must reference a journey expectation
  // with provenance matching THIS run.
  const expectations = journeyExpectations(journey);
  const seenExpectationIds = new Set<string>();
  for (const result of results) {
    const expected = result.expected as ExpectedObservation | undefined;
    if (!expected || typeof expected.id !== 'string' || !expectations.has(expected.id)) {
      throw new ValidationDomainError(
        'FINALIZE_RESULTS_FOREIGN',
        `a result references an expectation that is not in journey ${journey.id} (${JSON.stringify(expected?.id ?? null)})`,
      );
    }
    if (seenExpectationIds.has(expected.id)) {
      throw new ValidationDomainError(
        'FINALIZE_RESULTS_FOREIGN',
        `duplicate result for expectation ${expected.id}`,
      );
    }
    seenExpectationIds.add(expected.id);
    const provenance = result.provenance as Partial<ObservationProvenance> | undefined;
    if (
      !provenance ||
      provenance.runId !== run.id ||
      provenance.journeyId !== journey.id ||
      provenance.stepId !== expected.stepId ||
      provenance.environmentId !== run.environmentId
    ) {
      throw new ValidationDomainError(
        'OBSERVATION_PROVENANCE_INVALID',
        `the result for ${expected.id} carries provenance that does not match run ${run.id} (foreign or broken provenance is rejected)`,
      );
    }
  }

  // Validate the execution error shape (fail closed on foreign kinds).
  let executionError: ExecutionError | undefined;
  if (input.executionError !== undefined) {
    const error = input.executionError as { kind?: unknown; reason?: unknown };
    if (
      (error.kind !== 'effect_policy_violation' && error.kind !== 'environment_error') ||
      typeof error.reason !== 'string' ||
      error.reason.trim() === ''
    ) {
      throw new ValidationDomainError(
        'FINALIZE_EXECUTION_ERROR_INVALID',
        'executionError must be { kind: effect_policy_violation | environment_error, reason: non-empty string }',
      );
    }
    executionError = input.executionError;
  }

  const completedAt =
    input.completedAt ??
    (results.reduce<string>((latest, result) => {
      const observedAt = result.provenance.observedAt ?? '';
      return observedAt > latest ? observedAt : latest;
    }, run.createdAt) || run.createdAt);

  const runProvenance = Object.freeze({
    runId: run.id,
    journeyId: journey.id,
    environmentId: run.environmentId,
    mode: run.mode,
    trigger: run.trigger,
  });

  let outcome: ValidationOutcome;
  let observations: readonly ValidationObservation[];

  if (executionError) {
    outcome = Object.freeze({
      kind: executionError.kind,
      provenance: runProvenance,
      reason: executionError.reason,
    });
    observations = results
      .map((result) => result.actual)
      .filter((actual): actual is ValidationObservation => actual !== null);
  } else {
    // The failure-recording path: every journey expectation must have a
    // MATCHED result. Missing → explicit failure (actual: null). Unmatched →
    // explicit failure with the actual observation.
    const failures: ValidationFailure[] = [];
    const matchedById = new Map<string, ObservationResult>();
    for (const result of results) {
      matchedById.set(result.expected.id, result);
    }
    for (const [expectationId, expected] of expectations) {
      const result = matchedById.get(expectationId);
      if (result === undefined || !result.matched) {
        failures.push(
          Object.freeze({
            kind: 'validation_failure' as const,
            failedStepId: expected.stepId,
            expected,
            actual: result?.actual ?? null,
            provenance: Object.freeze({
              runId: run.id,
              journeyId: journey.id,
              stepId: expected.stepId,
              environmentId: run.environmentId,
              observedAt: result?.provenance.observedAt ?? completedAt,
            }),
          }),
        );
      }
    }
    observations = results
      .map((result) => result.actual)
      .filter((actual): actual is ValidationObservation => actual !== null);

    if (failures.length > 0) {
      // A failure is NEVER silently discarded and NEVER healthy.
      outcome = Object.freeze({
        kind: 'validation_failure',
        provenance: runProvenance,
        failures: Object.freeze(failures),
      });
    } else {
      // Every expectation matched → every declared criterion is satisfied
      // (criteria reference journey expectations by construction).
      outcome = Object.freeze({
        kind: 'healthy',
        provenance: runProvenance,
        satisfiedCriteria: Object.freeze(journey.successCriteria.map((criterion) => criterion.id)),
      });
    }
  }

  return Object.freeze({
    ...run,
    status: 'completed',
    observations: Object.freeze(observations),
    outcome,
    completedAt,
  });
}

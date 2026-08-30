import { describe, it, expect } from 'vitest';

/**
 * WORK-064 Task 6 — typed observations and validation outcomes with full
 * provenance (spec/work-orders/WORK-064.md invariant 6 + required proof 5;
 * spec/architecture/v1.1/evidence-provenance-model.md §5 "The
 * no-silent-healthy rule").
 *
 * THE INVARIANT: a validation failure is never silently discarded, never
 * converted into a false healthy state, and never directly converted into an
 * ungoverned code change. A missing observation is an EXPLICIT failure.
 */
import {
  defineValidationJourney,
  describeEnvironment,
  admitValidationRun,
  recordObservation,
  evaluateObservation,
  finalizeValidationRun,
  ValidationDomainError,
  type ValidationJourney,
  type ValidationRun,
  type ExpectedObservation,
  type ValidationObservation,
  type ObservationResult,
  type TestIdentitySource,
  type Environment,
} from '../../src/continuous-validation/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const unauthenticated: TestIdentitySource = { kind: 'unauthenticated' };

const previewEnv: Environment = describeEnvironment({
  id: 'env-preview',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY'],
});

/**
 * A two-step journey: a DOM heading and a network response. Two success
 * criteria — healthy requires BOTH.
 */
const journey: ValidationJourney = defineValidationJourney({
  id: 'journey-sign-in-page',
  name: 'The sign-in page renders',
  identityRequirement: 'unauthenticated',
  allowedModes: ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'],
  effectPolicy: 'READ_ONLY',
  steps: [
    {
      id: 'step-open-sign-in',
      name: 'open the sign-in page',
      expectedObservations: [
        {
          id: 'obs-heading',
          stepId: 'step-open-sign-in',
          kind: 'dom',
          description: 'the sign-in heading is visible',
          matcher: { kind: 'equals', value: 'Sign in to WorkflowOS' },
        },
      ],
    },
    {
      id: 'step-load-session',
      name: 'the session endpoint responds',
      expectedObservations: [
        {
          id: 'obs-session-status',
          stepId: 'step-load-session',
          kind: 'network',
          description: 'the session endpoint returns 401 for anonymous visitors',
          matcher: { kind: 'status_code', status: 401 },
        },
      ],
    },
  ],
  successCriteria: [
    {
      id: 'criterion-heading',
      description: 'the heading renders',
      requiresObservationIds: ['obs-heading'],
    },
    {
      id: 'criterion-session',
      description: 'the session endpoint responds',
      requiresObservationIds: ['obs-session-status'],
    },
  ],
});

const admittedRun: ValidationRun = admitValidationRun({
  journey,
  identitySource: unauthenticated,
  environment: previewEnv,
  mode: 'PRE_MERGE',
  trigger: 'PR',
  runId: 'run-prov-1',
  now: () => new Date('2026-08-30T12:00:00.000Z'),
}).run as ValidationRun;

const observedAt = '2026-08-30T12:00:01.000Z';

function observation(
  id: string,
  expected: ExpectedObservation,
  value: unknown,
): ValidationObservation {
  return recordObservation({
    id,
    kind: expected.kind,
    value,
    provenance: {
      runId: admittedRun.id,
      journeyId: journey.id,
      stepId: expected.stepId,
      environmentId: previewEnv.id,
      observedAt,
    },
  });
}

function matchedResult(
  expected: ExpectedObservation,
  actual: ValidationObservation | null,
): ObservationResult {
  return {
    expected,
    actual,
    matched: evaluateObservation(expected, actual),
    provenance: {
      runId: admittedRun.id,
      journeyId: journey.id,
      stepId: expected.stepId,
      environmentId: previewEnv.id,
      observedAt,
    },
  };
}

const headingExpected = journey.steps[0]?.expectedObservations[0] as ExpectedObservation;
const sessionExpected = journey.steps[1]?.expectedObservations[0] as ExpectedObservation;

// ---------------------------------------------------------------------------
// §1 recordObservation — the provenance guard
// ---------------------------------------------------------------------------

describe('WORK-064 observation recording — provenance guard', () => {
  it('records an observation with complete provenance', () => {
    const obs = observation('obs-1', headingExpected, 'Sign in to WorkflowOS');
    expect(obs.id).toBe('obs-1');
    expect(obs.kind).toBe('dom');
    expect(obs.provenance.runId).toBe('run-prov-1');
    expect(obs.provenance.journeyId).toBe('journey-sign-in-page');
    expect(obs.provenance.stepId).toBe('step-open-sign-in');
    expect(obs.provenance.environmentId).toBe('env-preview');
    expect(obs.provenance.observedAt).toBe(observedAt);
  });

  it('rejects an observation with missing provenance fields', () => {
    expect(() =>
      recordObservation({
        id: 'obs-x',
        kind: 'dom',
        value: 'x',
        // An empty runId is a valid-typed provenance shape — the runtime
        // guard must reject it (missing provenance).
        provenance: { runId: '', journeyId: journey.id, stepId: 'step-open-sign-in', environmentId: previewEnv.id, observedAt },
      }),
    ).toThrow(ValidationDomainError);
    expect(() =>
      recordObservation({
        id: 'obs-x',
        // @ts-expect-error — invalid kind at runtime
        kind: 'vibes',
        value: 'x',
        provenance: {
          runId: admittedRun.id,
          journeyId: journey.id,
          stepId: 'step-open-sign-in',
          environmentId: previewEnv.id,
          observedAt,
        },
      }),
    ).toThrow(ValidationDomainError);
  });
});

// ---------------------------------------------------------------------------
// §2 evaluateObservation — the deterministic matchers
// ---------------------------------------------------------------------------

describe('WORK-064 observation evaluation — deterministic matchers', () => {
  it('equals: deep structural equality', () => {
    expect(
      evaluateObservation(headingExpected, observation('a', headingExpected, 'Sign in to WorkflowOS')),
    ).toBe(true);
    expect(
      evaluateObservation(headingExpected, observation('a', headingExpected, 'Welcome back')),
    ).toBe(false);
  });

  it('exists: presence matches; absence NEVER matches', () => {
    const existsExpected: ExpectedObservation = {
      ...headingExpected,
      matcher: { kind: 'exists' },
    };
    expect(evaluateObservation(existsExpected, observation('a', existsExpected, null))).toBe(true);
    expect(evaluateObservation(existsExpected, null)).toBe(false);
  });

  it('contains_text: substring containment', () => {
    const textExpected: ExpectedObservation = {
      ...headingExpected,
      matcher: { kind: 'contains_text', text: 'WorkflowOS' },
    };
    expect(evaluateObservation(textExpected, observation('a', textExpected, 'Sign in to WorkflowOS today'))).toBe(true);
    expect(evaluateObservation(textExpected, observation('a', textExpected, 'Sign in elsewhere'))).toBe(false);
    expect(evaluateObservation(textExpected, observation('a', textExpected, 42))).toBe(false);
  });

  it('status_code: network status equality (number or {status} shape)', () => {
    expect(evaluateObservation(sessionExpected, observation('a', sessionExpected, 401))).toBe(true);
    expect(evaluateObservation(sessionExpected, observation('a', sessionExpected, { status: 401 }))).toBe(true);
    expect(evaluateObservation(sessionExpected, observation('a', sessionExpected, 500))).toBe(false);
  });

  it('a kind mismatch never matches', () => {
    const domValue = observation('a', sessionExpected, 401); // dom kind obs vs network expectation
    expect(evaluateObservation(sessionExpected, { ...domValue, kind: 'dom' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §3 finalizeValidationRun — the typed outcomes (the no-false-healthy core)
// ---------------------------------------------------------------------------

describe('WORK-064 outcome finalization — the no-false-healthy core', () => {
  it('ALL declared success criteria satisfied → healthy (with satisfiedCriteria provenance)', () => {
    const results = [
      matchedResult(headingExpected, observation('o-1', headingExpected, 'Sign in to WorkflowOS')),
      matchedResult(sessionExpected, observation('o-2', sessionExpected, 401)),
    ];
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results,
      completedAt: '2026-08-30T12:00:05.000Z',
    });
    expect(completed.status).toBe('completed');
    expect(completed.outcome?.kind).toBe('healthy');
    expect(completed.outcome).toMatchObject({
      kind: 'healthy',
      satisfiedCriteria: ['criterion-heading', 'criterion-session'],
    });
    expect(completed.completedAt).toBe('2026-08-30T12:00:05.000Z');
    // The observations are preserved on the completed run:
    expect(completed.observations).toHaveLength(2);
  });

  it('a FAILED expected DOM observation yields validation_failure with full provenance', () => {
    const results = [
      matchedResult(headingExpected, observation('o-1', headingExpected, 'Welcome back')),
      matchedResult(sessionExpected, observation('o-2', sessionExpected, 401)),
    ];
    const completed = finalizeValidationRun({ run: admittedRun, journey, results });
    expect(completed.outcome?.kind).toBe('validation_failure');
    if (completed.outcome?.kind === 'validation_failure') {
      expect(completed.outcome.failures).toHaveLength(1);
      const failure = completed.outcome.failures[0];
      if (!failure) throw new Error('expected a failure record');
      expect(failure.failedStepId).toBe('step-open-sign-in');
      expect(failure.expected.id).toBe('obs-heading');
      expect(failure.actual?.value).toBe('Welcome back');
      // The full provenance chain is preserved on the failure:
      expect(failure.provenance).toMatchObject({
        runId: 'run-prov-1',
        journeyId: 'journey-sign-in-page',
        stepId: 'step-open-sign-in',
        environmentId: 'env-preview',
        observedAt,
      });
      // The run-level provenance is on the outcome:
      expect(completed.outcome.provenance).toMatchObject({
        runId: 'run-prov-1',
        journeyId: 'journey-sign-in-page',
        environmentId: 'env-preview',
        mode: 'PRE_MERGE',
        trigger: 'PR',
      });
    }
  });

  it('a MISSING observation is an EXPLICIT validation_failure — never silently healthy', () => {
    // Only the heading result is supplied; the session observation never
    // arrived. The run CANNOT be healthy.
    const results = [matchedResult(headingExpected, observation('o-1', headingExpected, 'Sign in to WorkflowOS'))];
    const completed = finalizeValidationRun({ run: admittedRun, journey, results });
    expect(completed.outcome?.kind).toBe('validation_failure');
    if (completed.outcome?.kind === 'validation_failure') {
      expect(completed.outcome.failures).toHaveLength(1);
      const failure = completed.outcome.failures[0];
      if (!failure) throw new Error('expected a failure record');
      expect(failure.expected.id).toBe('obs-session-status');
      expect(failure.actual).toBeNull(); // the explicit missing-observation record
      expect(failure.provenance.stepId).toBe('step-load-session');
    }
  });

  it('an EMPTY result set is a validation_failure, not healthy (nothing was observed)', () => {
    const completed = finalizeValidationRun({ run: admittedRun, journey, results: [] });
    expect(completed.outcome?.kind).toBe('validation_failure');
  });

  it('effect-policy rejection during execution yields effect_policy_violation', () => {
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [],
      executionError: {
        kind: 'effect_policy_violation',
        reason: 'the executor attempted a mutation beyond the admitted READ_ONLY policy',
      },
    });
    expect(completed.outcome?.kind).toBe('effect_policy_violation');
    if (completed.outcome?.kind === 'effect_policy_violation') {
      expect(completed.outcome.reason).toContain('READ_ONLY');
      expect(completed.outcome.provenance.runId).toBe('run-prov-1');
    }
  });

  it('environment/deployment unavailability yields environment_error', () => {
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [],
      executionError: {
        kind: 'environment_error',
        reason: 'the preview deployment was unreachable (connect timeout)',
      },
    });
    expect(completed.outcome?.kind).toBe('environment_error');
    if (completed.outcome?.kind === 'environment_error') {
      expect(completed.outcome.reason).toContain('unreachable');
      expect(completed.outcome.provenance.environmentId).toBe('env-preview');
    }
  });

  it('an invalid executionError kind is rejected (fail closed — unknown outcomes unrepresentable)', () => {
    expect(() =>
      finalizeValidationRun({
        run: admittedRun,
        journey,
        results: [],
        // @ts-expect-error — foreign error kind at runtime
        executionError: { kind: 'whoopsie', reason: 'x' },
      }),
    ).toThrow(ValidationDomainError);
  });

  it('the completed run is immutable and completed once (no double finalization)', () => {
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [
        matchedResult(headingExpected, observation('o-1', headingExpected, 'Sign in to WorkflowOS')),
        matchedResult(sessionExpected, observation('o-2', sessionExpected, 401)),
      ],
    });
    expect(() =>
      finalizeValidationRun({ run: completed, journey, results: [] }),
    ).toThrow(ValidationDomainError);
  });
});

// ---------------------------------------------------------------------------
// §4 Provenance integrity + foreign-result rejection
// ---------------------------------------------------------------------------

describe('WORK-064 outcome finalization — provenance integrity', () => {
  it('a result whose provenance does not match the run is rejected', () => {
    const foreignResult: ObservationResult = {
      expected: headingExpected,
      actual: observation('o-1', headingExpected, 'Sign in to WorkflowOS'),
      matched: true,
      provenance: {
        runId: 'run-SOMEONE-ELSE',
        journeyId: journey.id,
        stepId: 'step-open-sign-in',
        environmentId: previewEnv.id,
        observedAt,
      },
    };
    expect(() =>
      finalizeValidationRun({ run: admittedRun, journey, results: [foreignResult] }),
    ).toThrow(ValidationDomainError);
  });

  it('a result referencing an observation NOT in the journey is rejected (foreign results)', () => {
    const foreignExpected: ExpectedObservation = {
      id: 'obs-not-in-journey',
      stepId: 'step-open-sign-in',
      kind: 'dom',
      description: 'foreign expectation',
      matcher: { kind: 'exists' },
    };
    const foreignResult: ObservationResult = {
      expected: foreignExpected,
      actual: null,
      matched: false,
      provenance: {
        runId: admittedRun.id,
        journeyId: journey.id,
        stepId: 'step-open-sign-in',
        environmentId: previewEnv.id,
        observedAt,
      },
    };
    expect(() =>
      finalizeValidationRun({ run: admittedRun, journey, results: [foreignResult] }),
    ).toThrow(ValidationDomainError);
  });

  it('a journey mismatch with the run is rejected', () => {
    const otherJourney = defineValidationJourney({
      ...journey,
      id: 'journey-somebody-elses',
    });
    expect(() =>
      finalizeValidationRun({
        run: admittedRun,
        journey: otherJourney,
        results: [],
      }),
    ).toThrow(ValidationDomainError);
  });

  it('duplicate results for the same expected observation are rejected', () => {
    const result = matchedResult(headingExpected, observation('o-1', headingExpected, 'Sign in to WorkflowOS'));
    expect(() =>
      finalizeValidationRun({ run: admittedRun, journey, results: [result, result] }),
    ).toThrow(ValidationDomainError);
  });
});

// ---------------------------------------------------------------------------
// §5 The mutation/discrimination proof (required proof 5: removing the
//    failure-recording path makes these assertions FAIL)
// ---------------------------------------------------------------------------

describe('WORK-064 no-false-healthy — the mutation-killing discriminations', () => {
  /**
   * The failure-recording path is the code that turns unmatched/missing
   * expected observations into the typed validation_failure outcome. Every
   * assertion below targets that path directly: if a future edit removes or
   * weakens it (e.g. finalizing healthy on "no results" or skipping missing
   * observations), these tests fail — the regression suite is the proof.
   */
  it('healthy is ONLY reachable when EVERY journey expectation has a matched result', () => {
    const matchedHeading = matchedResult(
      headingExpected,
      observation('o-1', headingExpected, 'Sign in to WorkflowOS'),
    );
    // All four failure shapes must NOT be healthy:
    const shapes: readonly (readonly ObservationResult[])[] = [
      [], // nothing observed
      [matchedHeading], // one of two observed
      [
        matchedHeading,
        matchedResult(sessionExpected, observation('o-2', sessionExpected, 500)), // mismatched
      ],
      [
        matchedHeading,
        matchedResult(sessionExpected, null), // explicitly missing
      ],
    ];
    for (const results of shapes) {
      const completed = finalizeValidationRun({ run: admittedRun, journey, results });
      expect(completed.outcome?.kind).not.toBe('healthy');
      expect(completed.outcome?.kind).toBe('validation_failure');
    }
    // And the complete shape IS healthy:
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [
        matchedHeading,
        matchedResult(sessionExpected, observation('o-2', sessionExpected, 401)),
      ],
    });
    expect(completed.outcome?.kind).toBe('healthy');
  });

  it('a run whose criteria are ALL satisfied but with an extra unmatched expectation is NOT healthy', () => {
    // Craft a results set where criterion observations match but the journey
    // declares an expectation with no result (the criterion references a
    // subset). Missing expectation → failure.
    const threeObsJourney = defineValidationJourney({
      id: 'journey-three-obs',
      name: 'three observations, two criteria',
      identityRequirement: 'unauthenticated',
      allowedModes: ['PRE_MERGE'],
      effectPolicy: 'READ_ONLY',
      steps: [
        {
          id: 'step-1',
          name: 'step one',
          expectedObservations: [
            { id: 'obs-a', stepId: 'step-1', kind: 'dom', description: 'a', matcher: { kind: 'exists' } },
            { id: 'obs-b', stepId: 'step-1', kind: 'dom', description: 'b', matcher: { kind: 'exists' } },
          ],
        },
        {
          id: 'step-2',
          name: 'step two',
          expectedObservations: [
            { id: 'obs-c', stepId: 'step-2', kind: 'dom', description: 'c', matcher: { kind: 'exists' } },
          ],
        },
      ],
      successCriteria: [
        { id: 'crit-1', description: 'a and b', requiresObservationIds: ['obs-a', 'obs-b'] },
      ],
    });
    const run = admitValidationRun({
      journey: threeObsJourney,
      identitySource: unauthenticated,
      environment: previewEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      runId: 'run-three-obs',
    }).run as ValidationRun;
    const expectedA = threeObsJourney.steps[0]?.expectedObservations[0] as ExpectedObservation;
    const expectedB = threeObsJourney.steps[0]?.expectedObservations[1] as ExpectedObservation;
    const resultFor = (expected: ExpectedObservation): ObservationResult => ({
      expected,
      actual: recordObservation({
        id: `o-${expected.id}`,
        kind: expected.kind,
        value: null,
        provenance: {
          runId: run.id,
          journeyId: threeObsJourney.id,
          stepId: expected.stepId,
          environmentId: previewEnv.id,
          observedAt,
        },
      }),
      matched: true,
      provenance: {
        runId: run.id,
        journeyId: threeObsJourney.id,
        stepId: expected.stepId,
        environmentId: previewEnv.id,
        observedAt,
      },
    });
    // obs-c has NO result: both criteria are satisfiable from obs-a/obs-b,
    // but the journey's full expectation set is unmet → NOT healthy.
    const completed = finalizeValidationRun({
      run,
      journey: threeObsJourney,
      results: [resultFor(expectedA), resultFor(expectedB)],
    });
    expect(completed.outcome?.kind).toBe('validation_failure');
  });
});

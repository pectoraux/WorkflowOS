import { describe, it, expect } from 'vitest';

/**
 * WORK-065 — the default BrowserValidationAgent: the full execution path
 * (admit → enforce EffectPolicy → execute → capture → finalize → map into
 * /verification) with adversarial proofs for every failure semantic.
 *
 * The agent CONSUMES the WORK-064 ContinuousValidationService (admission +
 * finalization + evidence mapping) and a BrowserDriver (WORK-036's neutral
 * port). These tests use a deterministic FakeBrowserDriver + a minimal
 * FakeVerificationService (the only /verification method the agent exercises
 * is attachEvidence — no second verification authority). The real-browser
 * integration test lives in real-browser-execution.test.ts.
 */
import {
  defineValidationJourney,
  describeEnvironment,
  DefaultContinuousValidationService,
  InMemoryValidationRunRepository,
  type ValidationJourney,
  type Environment,
  type TestIdentitySource,
} from '../../src/continuous-validation/index.js';
import type { AuthenticatedPrincipal } from '@modules/auth/index.js';
import {
  DefaultBrowserValidationAgent,
  defineBrowserJourneyPlan,
} from '../../src/browser-validation/index.js';
import { createLogger } from '@platform/logger.js';
import { FakeBrowserDriver, FakeVerificationService } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const logger = createLogger({ level: 'silent' });

const syntheticPrincipal: AuthenticatedPrincipal = {
  externalId: 'svc-browser-validation-01',
  label: 'browser validation runner',
  provider: 'apikey',
};

const unauthenticated: TestIdentitySource = { kind: 'unauthenticated' };
const synthetic: TestIdentitySource = {
  kind: 'synthetic',
  principal: syntheticPrincipal,
  principalClass: 'test_service_account',
  capabilities: ['project.read'],
  tenantId: 'tenant-preview',
  issuanceReason: 'PR preview browser validation run',
};

const previewReadOnlyEnv: Environment = describeEnvironment({
  id: 'env-preview-ro',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY'],
});

const previewMutationEnv: Environment = describeEnvironment({
  id: 'env-preview-mut',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-preview',
});

const previewForbiddenEnv: Environment = describeEnvironment({
  id: 'env-preview-forbidden',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'FORBIDDEN'],
  approvedSafeMechanism: true,
});

/** A read-only journey: navigate + extract the heading. */
const readJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-sign-in-page',
  name: 'The sign-in page renders',
  identityRequirement: 'unauthenticated',
  allowedModes: ['PRE_MERGE'],
  effectPolicy: 'READ_ONLY',
  steps: [
    {
      id: 'step-open',
      name: 'open the sign-in page',
      expectedObservations: [
        { id: 'obs-heading', stepId: 'step-open', kind: 'dom', description: 'heading visible', matcher: { kind: 'contains_text', text: 'Sign in' } },
        { id: 'obs-status', stepId: 'step-open', kind: 'network', description: 'page loaded', matcher: { kind: 'status_code', status: 200 } },
      ],
    },
  ],
  successCriteria: [{ id: 'crit-page', description: 'page renders', requiresObservationIds: ['obs-heading', 'obs-status'] }],
});

/** A mutation journey: type into a form + click submit. */
const mutationJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-sign-in',
  name: 'A user signs in',
  identityRequirement: 'authenticated',
  allowedModes: ['PRE_MERGE'],
  effectPolicy: 'SAFE_MUTATION',
  steps: [
    {
      id: 'step-fill',
      name: 'fill the sign-in form',
      expectedObservations: [
        { id: 'obs-submitted', stepId: 'step-fill', kind: 'dom', description: 'form submitted', matcher: { kind: 'exists' } },
      ],
    },
  ],
  successCriteria: [{ id: 'crit-sign-in', description: 'sign-in completes', requiresObservationIds: ['obs-submitted'] }],
});

/** A FORBIDDEN journey (admitted only behind the architect-approved safe mechanism). */
const forbiddenJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-forbidden-checkout',
  name: 'A real checkout (forbidden in synthetic runs)',
  identityRequirement: 'authenticated',
  allowedModes: ['PRE_MERGE'],
  effectPolicy: 'FORBIDDEN',
  steps: [
    {
      id: 'step-checkout',
      name: 'perform the checkout',
      expectedObservations: [
        { id: 'obs-confirmation', stepId: 'step-checkout', kind: 'dom', description: 'confirmation page', matcher: { kind: 'exists' } },
      ],
    },
  ],
  successCriteria: [{ id: 'crit-checkout', description: 'checkout completes', requiresObservationIds: ['obs-confirmation'] }],
});

/** The read journey's plan: navigate (satisfies obs-status) + extract (satisfies obs-heading). */
const readPlan = defineBrowserJourneyPlan(
  {
    journeyId: readJourney.id,
    readonlySafeNavigationTargets: ['https://example.com/sign-in'],
    steps: [
      {
        stepId: 'step-open',
        actions: [
          { kind: 'navigate', url: 'https://example.com/sign-in', satisfiesObservationId: 'obs-status' },
          { kind: 'extract', selector: 'h1', satisfiesObservationId: 'obs-heading' },
        ],
      },
    ],
  },
  readJourney,
);

/** The mutation journey's plan: type + click (both satisfy obs-submitted via the click). */
const mutationPlan = defineBrowserJourneyPlan(
  {
    journeyId: mutationJourney.id,
    steps: [
      {
        stepId: 'step-fill',
        actions: [
          { kind: 'type', selector: 'input[name=email]', text: 'test@example.com' },
          { kind: 'click', selector: 'button[type=submit]', satisfiesObservationId: 'obs-submitted' },
        ],
      },
    ],
  },
  mutationJourney,
);

/** The forbidden journey's plan (never executes — FORBIDDEN rejects every action). */
const forbiddenPlan = defineBrowserJourneyPlan(
  {
    journeyId: forbiddenJourney.id,
    steps: [
      {
        stepId: 'step-checkout',
        actions: [
          { kind: 'navigate', url: 'https://example.com/checkout', satisfiesObservationId: 'obs-confirmation' },
          { kind: 'click', selector: 'button#pay' },
        ],
      },
    ],
  },
  forbiddenJourney,
);

const fixedClock = () => new Date('2026-08-30T12:00:00.000Z');

// ---------------------------------------------------------------------------
// The agent test harness
// ---------------------------------------------------------------------------

function buildAgent(driver: FakeBrowserDriver | undefined, verification: FakeVerificationService) {
  const cv = new DefaultContinuousValidationService({
    runRepository: new InMemoryValidationRunRepository(),
    verificationService: verification,
  });
  const agent = new DefaultBrowserValidationAgent({
    continuousValidationService: cv,
    driver,
    logger,
  });
  return { agent, cv, verification };
}

// ---------------------------------------------------------------------------
// §1  Happy path — a healthy read-only run
// ---------------------------------------------------------------------------

describe('WORK-065 agent §1 — happy path (healthy read-only run)', () => {
  it('navigates + extracts the heading → healthy, observations provenance-bound, evidence mapped into /verification', async () => {
    const driver = new FakeBrowserDriver({
      navigate: [{ finalUrl: 'https://example.com/sign-in', status: 200, title: 'Sign in' }],
      extract: [{ matched: true, text: 'Sign in to your account', finalUrl: 'https://example.com/sign-in' }],
    });
    const { agent, verification } = buildAgent(driver, new FakeVerificationService());

    const outcome = await agent.executeValidationRun({
      journey: readJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: readPlan,
      verificationRunId: 'ver-run-1',
      projectId: 'proj-1',
      runId: 'run-happy-1',
      now: fixedClock,
    });

    expect(outcome.admitted).toBe(true);
    expect(outcome.run).not.toBeNull();
    expect(outcome.run!.status).toBe('completed');
    expect(outcome.run!.outcome!.kind).toBe('healthy');
    expect(outcome.run!.outcome!.kind).toBe('healthy');
    if (outcome.run!.outcome!.kind === 'healthy') {
      expect(outcome.run!.outcome!.satisfiedCriteria).toContain('crit-page');
    }

    // Provenance: every observation carries the full run→journey→step→env→time chain.
    for (const obs of outcome.run!.observations) {
      expect(obs.provenance.runId).toBe('run-happy-1');
      expect(obs.provenance.journeyId).toBe('journey-sign-in-page');
      expect(obs.provenance.stepId).toBe('step-open');
      expect(obs.provenance.environmentId).toBe('env-preview-ro');
      expect(obs.provenance.observedAt).toBe('2026-08-30T12:00:00.000Z');
    }

    // Evidence mapping: the agent called /verification.attachEvidence once
    // (claim authority, server-side classification — the existing authority).
    expect(verification.recordedAttachCalls).toHaveLength(1);
    const call = verification.recordedAttachCalls[0]!;
    expect(call.projectId).toBe('proj-1');
    expect(call.verificationRunId).toBe('ver-run-1');
    expect(call.evidenceType).toBe('continuous_validation');
    expect(call.provider).toBe('agent');
    expect(call.result).toBe('pass'); // healthy → pass

    // The evidence reference binds back to the existing authority's row.
    expect(outcome.evidenceReference).not.toBeNull();
    expect(outcome.evidenceReference!.verificationEvidenceId).toBe('evidence_1');
    expect(outcome.evidenceReference!.verificationEvidenceAuthority).toBe('claim');
    expect(outcome.evidenceReference!.outcomeKind).toBe('healthy');

    // The driver was driven exactly as the plan declared (2 calls).
    expect(driver.recordedCalls.map((c) => c.operation)).toEqual(['open', 'extract']);
  });
});

// ---------------------------------------------------------------------------
// §2  Browser unavailable → environment_error (fail closed, never silent)
// ---------------------------------------------------------------------------

describe('WORK-065 agent §2 — browser unavailable → environment_error', () => {
  it('no driver configured → environment_error, NO action executed, NO evidence (the run is preserved with the typed outcome)', async () => {
    const { agent, verification } = buildAgent(undefined, new FakeVerificationService());

    const outcome = await agent.executeValidationRun({
      journey: readJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: readPlan,
      verificationRunId: 'ver-run-2',
      projectId: 'proj-2',
      runId: 'run-no-driver',
      now: fixedClock,
    });

    expect(outcome.admitted).toBe(true);
    expect(outcome.run!.outcome!.kind).toBe('environment_error');
    if (outcome.run!.outcome!.kind === 'environment_error') {
      expect(outcome.run!.outcome!.reason).toMatch(/no browser driver is configured/);
    }
    // No observations captured (the browser never ran):
    expect(outcome.run!.observations).toHaveLength(0);
    // The evidence mapping STILL ran (the run completed with environment_error
    // → 'blocked' evidence). The agent never silently drops a run.
    expect(verification.recordedAttachCalls).toHaveLength(1);
    expect(verification.recordedAttachCalls[0]!.result).toBe('blocked'); // environment_error → blocked
    expect(outcome.evidenceReference!.outcomeKind).toBe('environment_error');
  });
});

// ---------------------------------------------------------------------------
// §3  FORBIDDEN policy → effect_policy_violation (NO action executed)
// ---------------------------------------------------------------------------

describe('WORK-065 agent §3 — FORBIDDEN policy → effect_policy_violation', () => {
  it('a FORBIDDEN run rejects every action before execution (the browser agent performs no forbidden actions)', async () => {
    const driver = new FakeBrowserDriver({}); // would record calls if any action executed
    const { agent, verification } = buildAgent(driver, new FakeVerificationService());

    const outcome = await agent.executeValidationRun({
      journey: forbiddenJourney,
      identitySource: synthetic,
      environment: previewForbiddenEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: forbiddenPlan,
      verificationRunId: 'ver-run-3',
      projectId: 'proj-3',
      runId: 'run-forbidden',
      now: fixedClock,
    });

    expect(outcome.admitted).toBe(true); // admitted behind the safe mechanism
    expect(outcome.run!.outcome!.kind).toBe('effect_policy_violation');
    if (outcome.run!.outcome!.kind === 'effect_policy_violation') {
      expect(outcome.run!.outcome!.reason).toMatch(/FORBIDDEN/);
    }
    // NO driver call was made (every action rejected before execution):
    expect(driver.recordedCalls).toHaveLength(0);
    expect(verification.recordedAttachCalls[0]!.result).toBe('blocked'); // effect_policy_violation → blocked
  });
});

// ---------------------------------------------------------------------------
// §4  Mutation under READ_ONLY → effect_policy_violation (partial execution)
// ---------------------------------------------------------------------------

describe('WORK-065 agent §4 — mutation under READ_ONLY → effect_policy_violation', () => {
  it('a click under a READ_ONLY run is rejected before execution (the run stops at the violation)', async () => {
    // A read-only journey that (erroneously, or adversarially) declares a click.
    const readOnlyClickJourney: ValidationJourney = defineValidationJourney({
      id: 'journey-ro-click',
      name: 'A read-only journey that attempts a click',
      identityRequirement: 'unauthenticated',
      allowedModes: ['PRE_MERGE'],
      effectPolicy: 'READ_ONLY',
      steps: [
        {
          id: 'step-attempt-click',
          name: 'navigate then attempt a click',
          expectedObservations: [
            { id: 'obs-ro-status', stepId: 'step-attempt-click', kind: 'network', description: 'page loaded', matcher: { kind: 'status_code', status: 200 } },
            { id: 'obs-ro-clicked', stepId: 'step-attempt-click', kind: 'dom', description: 'clicked', matcher: { kind: 'exists' } },
          ],
        },
      ],
      successCriteria: [{ id: 'crit-ro', description: 'the run observes the page', requiresObservationIds: ['obs-ro-status'] }],
    });
    const roClickPlan = defineBrowserJourneyPlan(
      {
        journeyId: readOnlyClickJourney.id,
        readonlySafeNavigationTargets: ['https://example.com'],
        steps: [
          {
            stepId: 'step-attempt-click',
            actions: [
              { kind: 'navigate', url: 'https://example.com', satisfiesObservationId: 'obs-ro-status' },
              { kind: 'click', selector: 'button', satisfiesObservationId: 'obs-ro-clicked' },
            ],
          },
        ],
      },
      readOnlyClickJourney,
    );
    const driver = new FakeBrowserDriver({
      navigate: [{ finalUrl: 'https://example.com', status: 200, title: 'Example' }],
    });
    const { agent } = buildAgent(driver, new FakeVerificationService());

    const outcome = await agent.executeValidationRun({
      journey: readOnlyClickJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: roClickPlan,
      verificationRunId: 'ver-run-4',
      projectId: 'proj-4',
      runId: 'run-ro-click',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('effect_policy_violation');
    if (outcome.run!.outcome!.kind === 'effect_policy_violation') {
      expect(outcome.run!.outcome!.reason).toMatch(/READ_ONLY/);
    }
    // The navigate executed (read action, admitted); the click did NOT (rejected
    // before execution). Proven: only 1 driver call recorded.
    expect(driver.recordedCalls.map((c) => c.operation)).toEqual(['open']);
  });
});

// ---------------------------------------------------------------------------
// §5  Selector miss → validation_failure (actual: null, never healthy)
// ---------------------------------------------------------------------------

describe('WORK-065 agent §5 — selector miss → validation_failure', () => {
  it('an extract whose selector does not match → the observation is explicitly MISSING (actual: null) → validation_failure', async () => {
    const driver = new FakeBrowserDriver({
      navigate: [{ finalUrl: 'https://example.com/sign-in', status: 200, title: 'Sign in' }],
      extract: [{ matched: false, text: '', finalUrl: 'https://example.com/sign-in' }], // selector miss
    });
    const { agent } = buildAgent(driver, new FakeVerificationService());

    const outcome = await agent.executeValidationRun({
      journey: readJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: readPlan,
      verificationRunId: 'ver-run-5',
      projectId: 'proj-5',
      runId: 'run-selector-miss',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('validation_failure');
    if (outcome.run!.outcome!.kind === 'validation_failure') {
      // The heading observation is a failure (actual: null — the selector missed).
      const headingFailure = outcome.run!.outcome!.failures.find((f) => f.expected.id === 'obs-heading');
      expect(headingFailure).toBeDefined();
      expect(headingFailure!.actual).toBeNull(); // explicit missing — never silent
    }
  });
});

// ---------------------------------------------------------------------------
// §6  Timeout → environment_error (typed, provenance preserved)
// ---------------------------------------------------------------------------

describe('WORK-065 agent §6 — driver timeout → environment_error', () => {
  it('a navigate that throws a TimeoutError → environment_error, execution stops', async () => {
    const timeoutErr = new Error('page.goto: Timeout 30000ms exceeded');
    timeoutErr.name = 'TimeoutError';
    const driver = new FakeBrowserDriver({ navigate: [timeoutErr] });
    const { agent } = buildAgent(driver, new FakeVerificationService());

    const outcome = await agent.executeValidationRun({
      journey: readJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: readPlan,
      verificationRunId: 'ver-run-6',
      projectId: 'proj-6',
      runId: 'run-timeout',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('environment_error');
    if (outcome.run!.outcome!.kind === 'environment_error') {
      expect(outcome.run!.outcome!.reason).toMatch(/timeout|exceeded/i);
    }
    // The extract never ran (execution stopped at the navigate failure):
    expect(driver.recordedCalls.map((c) => c.operation)).toEqual(['open']);
  });
});

// ---------------------------------------------------------------------------
// §7  Missing expected observation → validation_failure (never silent)
// ---------------------------------------------------------------------------

describe('WORK-065 agent §7 — missing expected observation → validation_failure', () => {
  it('a journey with an expectation no action satisfies → the observation is MISSING → validation_failure', async () => {
    // A journey with TWO expectations, but the plan only satisfies ONE.
    const twoObsJourney: ValidationJourney = defineValidationJourney({
      id: 'journey-two-obs',
      name: 'A journey with two observations',
      identityRequirement: 'unauthenticated',
      allowedModes: ['PRE_MERGE'],
      effectPolicy: 'READ_ONLY',
      steps: [
        {
          id: 'step-open',
          name: 'open the page',
          expectedObservations: [
            { id: 'obs-a', stepId: 'step-open', kind: 'dom', description: 'heading', matcher: { kind: 'exists' } },
            { id: 'obs-b', stepId: 'step-open', kind: 'dom', description: 'footer', matcher: { kind: 'exists' } },
          ],
        },
      ],
      successCriteria: [{ id: 'crit-both', description: 'both render', requiresObservationIds: ['obs-a', 'obs-b'] }],
    });
    // The plan satisfies ONLY obs-a (obs-b is never captured → missing → failure).
    const partialPlan = defineBrowserJourneyPlan(
      {
        journeyId: twoObsJourney.id,
        steps: [
          { stepId: 'step-open', actions: [{ kind: 'extract', selector: 'h1', satisfiesObservationId: 'obs-a' }] },
        ],
      },
      twoObsJourney,
    );
    const driver = new FakeBrowserDriver({
      extract: [{ matched: true, text: 'Welcome', finalUrl: 'https://example.com' }],
    });
    const { agent } = buildAgent(driver, new FakeVerificationService());

    const outcome = await agent.executeValidationRun({
      journey: twoObsJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: partialPlan,
      verificationRunId: 'ver-run-7',
      projectId: 'proj-7',
      runId: 'run-missing-obs',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('validation_failure');
    if (outcome.run!.outcome!.kind === 'validation_failure') {
      const failureB = outcome.run!.outcome!.failures.find((f) => f.expected.id === 'obs-b');
      expect(failureB).toBeDefined();
      expect(failureB!.actual).toBeNull(); // missing — never silent, never healthy
    }
  });
});

// ---------------------------------------------------------------------------
// §8  Mutation journey (happy path) — SAFE_MUTATION admits the mutation
// ---------------------------------------------------------------------------

describe('WORK-065 agent §8 — mutation journey (SAFE_MUTATION)', () => {
  it('type + click under SAFE_MUTATION → healthy (the identity owns the state it mutates)', async () => {
    const driver = new FakeBrowserDriver({
      type: [{ matched: true, finalUrl: 'https://example.com/sign-in' }],
      click: [{ matched: true, finalUrl: 'https://example.com/dashboard' }],
    });
    const { agent } = buildAgent(driver, new FakeVerificationService());

    const outcome = await agent.executeValidationRun({
      journey: mutationJourney,
      identitySource: synthetic,
      environment: previewMutationEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: mutationPlan,
      verificationRunId: 'ver-run-8',
      projectId: 'proj-8',
      runId: 'run-mutation-happy',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('healthy');
    expect(driver.recordedCalls.map((c) => c.operation)).toEqual(['type', 'click']);
  });
});

// ---------------------------------------------------------------------------
// §9  Rejected admission → admitted: false, run: null, NO evidence
// ---------------------------------------------------------------------------

describe('WORK-065 agent §9 — rejected admission → no run, no evidence', () => {
  it('a POST_RELEASE run without a releaseRef → admission rejected → NO run, NO evidence', async () => {
    const driver = new FakeBrowserDriver({});
    const { agent, verification } = buildAgent(driver, new FakeVerificationService());

    const outcome = await agent.executeValidationRun({
      journey: readJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'POST_RELEASE',
      trigger: 'RELEASE',
      plan: readPlan,
      verificationRunId: 'ver-run-9',
      projectId: 'proj-9',
      runId: 'run-rejected',
      now: fixedClock,
      // no releaseRef → admission rejected
    });

    expect(outcome.admitted).toBe(false);
    expect(outcome.run).toBeNull();
    expect(outcome.evidenceReference).toBeNull();
    // No driver call, no evidence mapping:
    expect(driver.recordedCalls).toHaveLength(0);
    expect(verification.recordedAttachCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §10  Identity binding — the agent PRESENTS, never MINTS
// ---------------------------------------------------------------------------

describe('WORK-065 agent §10 — identity binding (presented, never minted)', () => {
  it('an unauthenticated identity is bound under READ_ONLY (the run records the null principal)', async () => {
    const driver = new FakeBrowserDriver({
      navigate: [{ finalUrl: 'https://example.com/sign-in', status: 200, title: 'Sign in' }],
      extract: [{ matched: true, text: 'Sign in', finalUrl: 'https://example.com/sign-in' }],
    });
    const { agent } = buildAgent(driver, new FakeVerificationService());

    const outcome = await agent.executeValidationRun({
      journey: readJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: readPlan,
      verificationRunId: 'ver-run-10',
      projectId: 'proj-10',
      runId: 'run-unauth',
      now: fixedClock,
    });

    expect(outcome.run!.identity.principalId).toBeNull(); // unauthenticated
    expect(outcome.run!.identity.principalClass).toBe('unauthenticated');
    expect(outcome.run!.identity.issuer).toBe('WORK-063');
  });

  it('a human principal is REJECTED as a TestIdentity (the load-bearing discrimination — propagated from WORK-064 admission)', async () => {
    const driver = new FakeBrowserDriver({});
    const { agent, verification } = buildAgent(driver, new FakeVerificationService());

    // A principal authenticated by a human interactive provider — rejected.
    const humanPrincipal: AuthenticatedPrincipal = {
      externalId: 'real-user@example.com',
      label: 'a real production user',
      provider: 'google', // human interactive — not in SYNTHETIC_IDENTITY_PROVIDERS
    };
    const humanSource: TestIdentitySource = {
      kind: 'synthetic',
      principal: humanPrincipal,
      principalClass: 'test_user',
      capabilities: ['project.read'],
      issuanceReason: 'attempt to run as a real user',
    };

    const outcome = await agent.executeValidationRun({
      journey: mutationJourney,
      identitySource: humanSource,
      environment: previewMutationEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: mutationPlan,
      verificationRunId: 'ver-run-10b',
      projectId: 'proj-10b',
      runId: 'run-human',
      now: fixedClock,
    });

    // Admission rejected (the WORK-064 admission boundary rejects the human principal):
    expect(outcome.admitted).toBe(false);
    expect(outcome.run).toBeNull();
    expect(outcome.evidenceReference).toBeNull();
    expect(verification.recordedAttachCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §11  Evidence mapping failure → the run is preserved, evidence reference null
// ---------------------------------------------------------------------------

describe('WORK-065 agent §11 — evidence mapping failure → run preserved, evidence null', () => {
  it('a failed attachEvidence → the run is still completed (outcome preserved); the evidence reference is null', async () => {
    const driver = new FakeBrowserDriver({
      navigate: [{ finalUrl: 'https://example.com/sign-in', status: 200, title: 'Sign in' }],
      extract: [{ matched: true, text: 'Sign in', finalUrl: 'https://example.com/sign-in' }],
    });
    const verification = new FakeVerificationService();
    verification.attachEvidenceShouldThrow = new Error('verification run not found');
    const { agent } = buildAgent(driver, verification);

    const outcome = await agent.executeValidationRun({
      journey: readJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: readPlan,
      verificationRunId: 'ver-run-missing',
      projectId: 'proj-11',
      runId: 'run-map-fail',
      now: fixedClock,
    });

    // The run completed healthy (the validation itself succeeded):
    expect(outcome.run!.outcome!.kind).toBe('healthy');
    // But the evidence mapping failed → evidenceReference is null (explicit, never silent):
    expect(outcome.evidenceReference).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §12  No second verification authority (the agent never creates verification runs)
// ---------------------------------------------------------------------------

describe('WORK-065 agent §12 — no second verification authority', () => {
  it('the agent NEVER calls createRun/findRun/evaluateCriterion on /verification (it only attaches evidence)', async () => {
    const driver = new FakeBrowserDriver({
      navigate: [{ finalUrl: 'https://example.com/sign-in', status: 200, title: 'Sign in' }],
      extract: [{ matched: true, text: 'Sign in', finalUrl: 'https://example.com/sign-in' }],
    });
    const verification = new FakeVerificationService();
    const { agent } = buildAgent(driver, verification);

    await agent.executeValidationRun({
      journey: readJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: readPlan,
      verificationRunId: 'ver-run-12',
      projectId: 'proj-12',
      runId: 'run-no-second-auth',
      now: fixedClock,
    });

    // The agent called ONLY attachEvidence (one call). Every other /verification
    // method throws "not used by the browser agent" — the agent never reached them.
    expect(verification.recordedAttachCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §13  Determinism — the same run produces the same outcome
// ---------------------------------------------------------------------------

describe('WORK-065 agent §13 — deterministic outcomes', () => {
  it('the same journey + plan + driver + clock produces the same outcome (deterministic)', async () => {
    const mkDriver = () =>
      new FakeBrowserDriver({
        navigate: [{ finalUrl: 'https://example.com/sign-in', status: 200, title: 'Sign in' }],
        extract: [{ matched: true, text: 'Sign in', finalUrl: 'https://example.com/sign-in' }],
      });
    const run = async () => {
      const { agent } = buildAgent(mkDriver(), new FakeVerificationService());
      return agent.executeValidationRun({
        journey: readJourney,
        identitySource: unauthenticated,
        environment: previewReadOnlyEnv,
        mode: 'PRE_MERGE',
        trigger: 'PR',
        plan: readPlan,
        verificationRunId: 'ver-run-13',
        projectId: 'proj-13',
        runId: 'run-deterministic',
        now: fixedClock,
      });
    };
    const a = await run();
    const b = await run();
    expect(JSON.stringify(a.run)).toBe(JSON.stringify(b.run));
  });
});

// ---------------------------------------------------------------------------
// §14  Navigation-target safety boundary — the driver is NEVER called for a
//      rejected navigation (the critical proof, PR #97 architect review)
// ---------------------------------------------------------------------------

describe('WORK-065 agent §14 — the driver is never called for a rejected navigation', () => {
  // A read-only journey with a network observation (a navigation satisfies it).
  const navJourney: ValidationJourney = defineValidationJourney({
    id: 'journey-nav-safety',
    name: 'A navigation journey',
    identityRequirement: 'unauthenticated',
    allowedModes: ['PRE_MERGE'],
    effectPolicy: 'READ_ONLY',
    steps: [
      {
        id: 'step-navigate',
        name: 'navigate to the page',
        expectedObservations: [
          { id: 'obs-status', stepId: 'step-navigate', kind: 'network', description: 'page loaded', matcher: { kind: 'status_code', status: 200 } },
        ],
      },
    ],
    successCriteria: [{ id: 'crit', description: 'page loads', requiresObservationIds: ['obs-status'] }],
  });

  it('READ_ONLY + a positively authorized safe navigation (URL in the allowlist) → the driver IS called → healthy', async () => {
    const driver = new FakeBrowserDriver({
      navigate: [{ finalUrl: 'https://example.com/sign-in', status: 200, title: 'Sign in' }],
    });
    const { agent } = buildAgent(driver, new FakeVerificationService());
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: navJourney.id,
        readonlySafeNavigationTargets: ['https://example.com/sign-in'],
        steps: [
          {
            stepId: 'step-navigate',
            actions: [
              { kind: 'navigate', url: 'https://example.com/sign-in', satisfiesObservationId: 'obs-status' },
            ],
          },
        ],
      },
      navJourney,
    );

    const outcome = await agent.executeValidationRun({
      journey: navJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan,
      verificationRunId: 'ver-nav-1',
      projectId: 'proj-nav-1',
      runId: 'run-nav-safe',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('healthy');
    // The driver WAS called (the navigation executed):
    expect(driver.recordedCalls.map((c) => c.operation)).toEqual(['open']);
  });

  // THE ATTACK SHAPE the architect required: a plain-path GET that may mutate
  // (e.g. /delete/123) under READ_ONLY. The OLD model (per-action targetPolicy)
  // would admit it if the caller asserted 'read_only_safe'; the NEW model
  // (authoritative allowlist) rejects it because /delete/123 is NOT in the
  // allowlist (unverified — no authoritative proof of safety).
  it('READ_ONLY + /delete/123 (a plain-path GET that may mutate, NOT in the allowlist) → the driver is NEVER called → effect_policy_violation', async () => {
    const driver = new FakeBrowserDriver({
      navigate: [{ finalUrl: 'https://example.com/delete/123', status: 200, title: 'Deleted' }],
    });
    const { agent } = buildAgent(driver, new FakeVerificationService());
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: navJourney.id,
        // The allowlist declares /sign-in safe — /delete/123 is NOT in it.
        readonlySafeNavigationTargets: ['https://example.com/sign-in'],
        steps: [
          {
            stepId: 'step-navigate',
            actions: [
              { kind: 'navigate', url: 'https://example.com/delete/123', satisfiesObservationId: 'obs-status' },
            ],
          },
        ],
      },
      navJourney,
    );

    const outcome = await agent.executeValidationRun({
      journey: navJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan,
      verificationRunId: 'ver-nav-2',
      projectId: 'proj-nav-2',
      runId: 'run-nav-delete-rejected',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('effect_policy_violation');
    if (outcome.run!.outcome!.kind === 'effect_policy_violation') {
      expect(outcome.run!.outcome!.reason).toMatch(/not proven read-only-safe|unverified/);
    }
    // CRITICAL PROOF: the driver was NEVER called (the navigation was rejected
    // before page.goto()):
    expect(driver.recordedCalls).toHaveLength(0);
  });

  it('READ_ONLY + a query-string URL NOT in the allowlist → the driver is NEVER called → effect_policy_violation (unverified)', async () => {
    const driver = new FakeBrowserDriver({});
    const { agent } = buildAgent(driver, new FakeVerificationService());
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: navJourney.id,
        // Empty allowlist — no navigation is proven read-only-safe.
        readonlySafeNavigationTargets: [],
        steps: [
          {
            stepId: 'step-navigate',
            actions: [
              { kind: 'navigate', url: 'https://example.com/?action=delete', satisfiesObservationId: 'obs-status' },
            ],
          },
        ],
      },
      navJourney,
    );

    const outcome = await agent.executeValidationRun({
      journey: navJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan,
      verificationRunId: 'ver-nav-3',
      projectId: 'proj-nav-3',
      runId: 'run-nav-query-rejected',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('effect_policy_violation');
    expect(outcome.run!.outcome!.kind === 'effect_policy_violation' && outcome.run!.outcome!.reason).toMatch(/not proven read-only-safe|unverified/);
    // CRITICAL PROOF: the driver was NEVER called:
    expect(driver.recordedCalls).toHaveLength(0);
  });

  it('READ_ONLY + a query-string URL IN the allowlist → the driver IS called → healthy (the journey authority declared it safe)', async () => {
    // The architect's ruling: "a query string is one possible signal, not a
    // proof of mutation." The allowlist is the authority. A query-string URL
    // the journey declared read-only-safe is admitted under READ_ONLY.
    const driver = new FakeBrowserDriver({
      navigate: [{ finalUrl: 'https://example.com/confirm?token=abc', status: 200, title: 'Confirmed' }],
    });
    const { agent } = buildAgent(driver, new FakeVerificationService());
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: navJourney.id,
        readonlySafeNavigationTargets: ['https://example.com/confirm?token=abc'],
        steps: [
          {
            stepId: 'step-navigate',
            actions: [
              { kind: 'navigate', url: 'https://example.com/confirm?token=abc', satisfiesObservationId: 'obs-status' },
            ],
          },
        ],
      },
      navJourney,
    );

    const outcome = await agent.executeValidationRun({
      journey: navJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan,
      verificationRunId: 'ver-nav-4',
      projectId: 'proj-nav-4',
      runId: 'run-nav-query-allowlisted',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('healthy');
    // The driver WAS called (the navigation executed):
    expect(driver.recordedCalls.map((c) => c.operation)).toEqual(['open']);
  });

  it('READ_ONLY + a file: URL navigation → the driver is NEVER called → effect_policy_violation (forbidden target)', async () => {
    const driver = new FakeBrowserDriver({
      navigate: [{ finalUrl: 'file:///etc/passwd', status: 200, title: 'passwd' }],
    });
    const { agent } = buildAgent(driver, new FakeVerificationService());
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: navJourney.id,
        readonlySafeNavigationTargets: [],
        steps: [
          {
            stepId: 'step-navigate',
            actions: [
              { kind: 'navigate', url: 'file:///etc/passwd', satisfiesObservationId: 'obs-status' },
            ],
          },
        ],
      },
      navJourney,
    );

    const outcome = await agent.executeValidationRun({
      journey: navJourney,
      identitySource: unauthenticated,
      environment: previewReadOnlyEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan,
      verificationRunId: 'ver-nav-5',
      projectId: 'proj-nav-5',
      runId: 'run-nav-file-rejected',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('effect_policy_violation');
    if (outcome.run!.outcome!.kind === 'effect_policy_violation') {
      expect(outcome.run!.outcome!.reason).toMatch(/forbidden/);
      expect(outcome.run!.outcome!.reason).toMatch(/file:/);
    }
    // CRITICAL PROOF: the driver was NEVER called:
    expect(driver.recordedCalls).toHaveLength(0);
  });

  it('FORBIDDEN + a safe navigation → the driver is NEVER called → effect_policy_violation (FORBIDDEN rejects every action)', async () => {
    // A FORBIDDEN journey admitted behind the architect-approved safe mechanism.
    const forbiddenNavJourney: ValidationJourney = defineValidationJourney({
      id: 'journey-nav-forbidden',
      name: 'A forbidden navigation journey',
      identityRequirement: 'authenticated',
      allowedModes: ['PRE_MERGE'],
      effectPolicy: 'FORBIDDEN',
      steps: [
        {
          id: 'step-navigate',
          name: 'navigate',
          expectedObservations: [
            { id: 'obs-status', stepId: 'step-navigate', kind: 'network', description: 'page loaded', matcher: { kind: 'status_code', status: 200 } },
          ],
        },
      ],
      successCriteria: [{ id: 'crit', description: 'page loads', requiresObservationIds: ['obs-status'] }],
    });
    const forbiddenEnv: Environment = describeEnvironment({
      id: 'env-forbidden',
      kind: 'preview',
      acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'FORBIDDEN'],
      approvedSafeMechanism: true,
    });
    const driver = new FakeBrowserDriver({});
    const { agent } = buildAgent(driver, new FakeVerificationService());
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: forbiddenNavJourney.id,
        readonlySafeNavigationTargets: ['https://example.com/checkout'],
        steps: [
          {
            stepId: 'step-navigate',
            actions: [
              { kind: 'navigate', url: 'https://example.com/checkout', satisfiesObservationId: 'obs-status' },
            ],
          },
        ],
      },
      forbiddenNavJourney,
    );

    const outcome = await agent.executeValidationRun({
      journey: forbiddenNavJourney,
      identitySource: synthetic,
      environment: forbiddenEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan,
      verificationRunId: 'ver-nav-6',
      projectId: 'proj-nav-6',
      runId: 'run-nav-forbidden',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('effect_policy_violation');
    expect(outcome.run!.outcome!.kind === 'effect_policy_violation' && outcome.run!.outcome!.reason).toMatch(/FORBIDDEN/);
    // CRITICAL PROOF: the driver was NEVER called:
    expect(driver.recordedCalls).toHaveLength(0);
  });

  it('SAFE_MUTATION + an unverified navigation (not in the allowlist) → the driver IS called (admitted under a mutation policy)', async () => {
    // A SAFE_MUTATION journey that navigates to /delete/123 (not in the
    // allowlist — unverified). The run has a mutation policy, so the
    // potentially-mutating navigation is within policy and admitted.
    const mutationNavJourney: ValidationJourney = defineValidationJourney({
      id: 'journey-nav-mutation',
      name: 'A mutation navigation journey',
      identityRequirement: 'authenticated',
      allowedModes: ['PRE_MERGE'],
      effectPolicy: 'SAFE_MUTATION',
      steps: [
        {
          id: 'step-navigate',
          name: 'navigate',
          expectedObservations: [
            { id: 'obs-status', stepId: 'step-navigate', kind: 'network', description: 'page loaded', matcher: { kind: 'status_code', status: 200 } },
          ],
        },
      ],
      successCriteria: [{ id: 'crit', description: 'page loads', requiresObservationIds: ['obs-status'] }],
    });
    const driver = new FakeBrowserDriver({
      navigate: [{ finalUrl: 'https://example.com/delete/123', status: 200, title: 'Deleted' }],
    });
    const { agent } = buildAgent(driver, new FakeVerificationService());
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: mutationNavJourney.id,
        // No allowlist — /delete/123 is unverified, but SAFE_MUTATION admits it.
        readonlySafeNavigationTargets: [],
        steps: [
          {
            stepId: 'step-navigate',
            actions: [
              { kind: 'navigate', url: 'https://example.com/delete/123', satisfiesObservationId: 'obs-status' },
            ],
          },
        ],
      },
      mutationNavJourney,
    );

    const outcome = await agent.executeValidationRun({
      journey: mutationNavJourney,
      identitySource: synthetic,
      environment: previewMutationEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan,
      verificationRunId: 'ver-nav-7',
      projectId: 'proj-nav-7',
      runId: 'run-nav-mutation-admitted',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('healthy');
    // The driver WAS called (the navigation executed):
    expect(driver.recordedCalls.map((c) => c.operation)).toEqual(['open']);
  });
});

/**
 * WORK-064 — Continuous Product Validation (public barrel).
 *
 * The domain/model authority for continuous product validation. It lives at
 * `src/continuous-validation/` (application-layer capability OUTSIDE
 * src/modules/ — the §34 benchmark / execution-policy / orchestration
 * precedent; NOT the 18th frozen module) and CONSUMES the existing
 * authorities:
 *
 *   - identity: `/auth` (AuthenticatedPrincipal — bound, never minted here);
 *   - verification/evidence: `/verification` (validation evidence references
 *     its Evidence rows — no parallel evidence store);
 *   - persistence: the ValidationRunRepository PORT (in-memory in this Work
 *     Order — NO schema migration is authorized; see the repository mapping
 *     note);
 *   - composition: `buildApp` constructs the service and exposes it on
 *     AppDeps for FUTURE consumers (WORK-065 browser agent, WORK-066
 *     scheduler).
 *
 * WORK-065 (browser execution), WORK-066 (scheduling), WORK-067 (signals),
 * WORK-068 (feedback conversion), WORK-069 (progressive release), and
 * WORK-070 (architecture fitness) are NOT implemented here. They are future
 * CONSUMERS of these contracts.
 */
export {
  // §1 vocabularies
  EFFECT_POLICIES,
  VALIDATION_MODES,
  VALIDATION_TRIGGERS,
  VALIDATION_OUTCOME_KINDS,
  OBSERVATION_KINDS,
  ENVIRONMENT_KINDS,
  TEST_PRINCIPAL_CLASSES,
  SYNTHETIC_PRINCIPAL_CLASSES,
  IDENTITY_REQUIREMENTS,
  TRIGGER_MODE_BINDING,
  VALIDATION_RUN_STATUSES,
  // §10 constructors
  defineValidationJourney,
  describeEnvironment,
  // errors
  ValidationDomainError,
  CONTINUOUS_VALIDATION_ERROR_CODES,
} from './types.js';
export {
  // Task 3 — fail-closed effect-policy admission
  admitEffectPolicy,
  environmentKindValidForMode,
} from './internal/effect-policy.js';
export type { EffectPolicyDecision } from './internal/effect-policy.js';
export type {
  EffectPolicy,
  ValidationMode,
  ValidationTrigger,
  ValidationOutcomeKind,
  ObservationKind,
  EnvironmentKind,
  TestPrincipalClass,
  IdentityRequirement,
  Environment,
  EnvironmentInput,
  ObservationMatcher,
  ExpectedObservation,
  ValidationStep,
  SuccessCriterion,
  ValidationJourney,
  ValidationJourneyInput,
  TestIdentityBinding,
  TestIdentitySource,
  ObservationProvenance,
  ValidationObservation,
  RunProvenance,
  ValidationFailure,
  ValidationOutcome,
  ValidationRun,
  ValidationRunStatus,
  ContinuousValidationErrorCode,
} from './types.js';

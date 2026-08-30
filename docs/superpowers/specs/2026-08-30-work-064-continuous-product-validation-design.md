# WORK-064 Continuous Product Validation — Design

**Status:** proposed design for implementation planning  
**Work Order:** WORK-064  
**Architecture:** v1.1 proposed; v1.0 remains frozen  
**Scope:** validation domain/model runtime only; WORK-065–070 remain separate

## 1. Goal

Establish one canonical runtime domain for synthetic product validation so WorkflowOS can define, admit, execute, record, and reason about meaningful customer journeys without creating a second workflow, execution, identity, or verification authority.

The existing WORK-064 Work Order is the normative scope. This design turns that scope into an implementation shape while preserving the repository's existing authorities and interfaces.

## 2. Repository-grounded constraints

The current repository already persists the following design-time authorities:

- `spec/architecture/v1.1/validation-model.md` — canonical validation domain model.
- `spec/architecture/v1.1/continuous-validation-lifecycle.md` — PRE_MERGE, POST_RELEASE, CONTINUOUS modes and policy/assurance bindings.
- `spec/architecture/v1.1/evidence-provenance-model.md` — raw observation → validation result → existing `/verification` evidence provenance.
- `spec/architecture/v1.1/dogfooding-model.md` — canonical WorkflowOS/customer-product dogfooding flow.
- `spec/work-orders/WORK-064.md` — scope, invariants, proof obligations, prohibitions, and stop conditions.

These artifacts are design-time authority. The implementation must not reinterpret them into a new architecture.

## 3. Proposed implementation boundaries

### 3.1 Validation domain

Introduce focused domain types for:

- `ValidationJourney`
- `ValidationRun`
- `TestIdentity`
- `Environment`
- `EffectPolicy`
- `ExpectedObservation`
- `Evidence`

The types should encode the invariants that can be represented locally and reject invalid combinations before execution admission.

`ValidationJourney` is the declaration. `ValidationRun` is the immutable execution record. `TestIdentity` identifies the synthetic principal supplied by the existing identity authority. `Environment` describes the target deployment and its permitted policy envelope. `ExpectedObservation` describes step-level expectations. `Evidence` is derived validation evidence with provenance into the existing verification authority.

### 3.2 Admission boundary

A dedicated admission operation should validate, in deterministic order:

1. journey has exactly one effect policy;
2. environment is compatible with the requested effect policy;
3. identity is synthetic and valid for the environment;
4. operating mode permits the policy;
5. dangerous production effects are rejected unless an explicitly approved safe mechanism is represented;
6. the run receives an explicit identity, environment, mode, and policy binding.

Admission failure must be typed and fail closed. The browser agent must consume this result rather than make independent authorization decisions.

### 3.3 Identity boundary

The validation domain consumes synthetic principals issued by WORK-063's identity authority. It must not mint, authenticate, or authorize principals itself.

The domain representation should carry enough provenance to prove:

- principal class;
- issuing authority;
- tenant/test-tenant binding;
- capability scope;
- synthetic status.

A production real-user principal must be discriminably rejected as a `TestIdentity`.

### 3.4 Environment/effect-policy matrix

The domain should make policy compatibility explicit rather than embedding scattered conditionals.

| Environment | READ_ONLY | SAFE_MUTATION | ISOLATED_MUTATION | FORBIDDEN |
|---|---|---|---|---|
| preview | allowed | allowed | allowed | rejected unless explicitly safe-mechanism-bound |
| isolated sandbox/test tenant | allowed | allowed | allowed | rejected |
| production | allowed | allowed only for synthetic-owned safe state | only with isolated test tenant / approved mechanism | rejected |

`FORBIDDEN` is an admission policy, not a browser-agent hint. No execution mechanism may downgrade or bypass it.

### 3.5 Observation and outcome model

Each journey step should have deterministic expected-observation evaluation. Observations must retain:

- journey identity/version;
- run identity;
- step identity/order;
- environment;
- test identity;
- timestamp/attempt metadata where already supported by repository conventions;
- observed value or safe reference;
- expected value/rule;
- match result.

Run outcomes must be explicit rather than inferred from missing records:

- `healthy`
- `validation_failure`
- `effect_policy_violation`
- `environment_error`

A failed observation must therefore remain represented in the run result and cannot accidentally become healthy through omission.

## 4. Evidence and existing authorities

WORK-064 owns the validation result and provenance model, not a new verification authority.

The intended chain is:

```text
raw observation
  → validation result
  → existing /verification evidence
```

The implementation should reference the existing verification evidence identity when one exists and preserve the upstream validation/run/step provenance. It must not introduce a second authoritative evidence lifecycle.

Likewise:

- failure → signal is consumed by WORK-067;
- signal → governed Work Item is consumed by WORK-068;
- browser execution is WORK-065;
- scheduling/triggers are WORK-066.

WORK-064 should expose stable domain contracts for these downstream consumers without implementing their runtimes.

## 5. Operating modes

Represent the three existing lifecycle modes as a closed set:

- `PRE_MERGE`
- `POST_RELEASE`
- `CONTINUOUS`

The implementation should encode the repository's documented policy envelope and assurance relationship, but must not implement scheduling. A run records the mode under which it was admitted; the trigger/scheduler remains external to WORK-064.

## 6. Dogfooding

Dogfooding is represented as canonical journey declarations and provenance, not as an autonomous runner.

The initial customer-product journey should be capable of expressing:

```text
authentication
→ organization
→ project
→ GitHub/Vercel integration
→ LLM/agent configuration
→ planning
→ Work Orders
→ execution
→ parallelism
→ verification
→ review
→ deployment
→ validation
```

Because WORK-063 is now complete as an architecture decision but its runtime identity implementation remains future-gated, authenticated journeys must not encode the historical demo key as a permanent identity mechanism.

## 7. API shape

The implementation should expose a small domain-facing surface rather than leaking persistence or browser concerns into the model. The exact repository naming conventions must be followed after code inspection.

Conceptually:

```ts
type AdmitValidationRun = {
  journey: ValidationJourney;
  identity: TestIdentity;
  environment: Environment;
  mode: ValidationMode;
};

function admitValidationRun(input: AdmitValidationRun):
  | { ok: true; run: ValidationRun }
  | { ok: false; error: ValidationAdmissionError };

function evaluateObservation(
  run: ValidationRun,
  observation: RawObservation,
  expected: ExpectedObservation,
): ObservationResult;

function finalizeValidationRun(
  run: ValidationRun,
  results: readonly ObservationResult[],
): ValidationResult;
```

These are conceptual contracts, not permission to ignore existing repository APIs. Before implementation, each must be reconciled with the actual backend module structure and existing error/result conventions.

## 8. Persistence strategy

No schema migration is authorized by WORK-064's current scope. The first implementation should therefore keep the domain model at the existing persistence boundary and avoid inventing durable tables or a parallel evidence store.

If repository inspection demonstrates that durable ValidationRun/Observation state is impossible without a schema change, stop and raise an Architecture Change Request rather than silently expanding WORK-064.

## 9. Verification strategy

Tests must be written first for the load-bearing invariants.

Required deterministic proof cases:

1. production + `FORBIDDEN` → admission rejected;
2. READ_ONLY-only environment + `SAFE_MUTATION` → admission rejected;
3. real production principal supplied as `TestIdentity` → rejected;
4. valid synthetic identity + permitted environment/policy → admitted;
5. failed observation → explicit `validation_failure`;
6. removing the failure-recording path makes the no-false-healthy regression fail;
7. validation evidence references existing verification evidence rather than replacing it;
8. browser/execution contracts cannot authorize a policy escalation;
9. static no-second-authority checks remain green;
10. operating-mode policy matrix is exhaustive and rejects unknown combinations.

Tests should include discrimination/property-style cases where useful: specifically, mutate the relevant policy/identity/result path and prove the expected invariant fails rather than merely checking a happy-path value.

## 10. Non-goals

This design deliberately excludes:

- browser-agent runtime (WORK-065);
- scheduling/change-trigger runtime (WORK-066);
- signal correlation runtime (WORK-067);
- feedback-to-Work-Item automation (WORK-068);
- progressive release runtime (WORK-069);
- architecture-fitness runtime (WORK-070);
- authentication implementation (WORK-063);
- replacement execution authority;
- replacement verification authority;
- replacement workflow authority;
- production destructive validation.

## 11. Stop conditions

Stop implementation and raise an ACR if any requirement forces:

- a second verification/evidence authority;
- a second identity authority;
- a second execution authority;
- a second workflow authority;
- uncontrolled production destructive side effects;
- browser-driven code mutation;
- permanent demo-key authentication;
- modification of frozen v1.0 architecture.

## 12. Recommended approach

Use a focused domain-first implementation with a policy/admission boundary and immutable validation results. Keep browser, scheduling, signals, and persistence integrations behind contracts owned by their respective future Work Orders. This minimizes architectural coupling and gives WORK-065 a stable contract to execute against while keeping WORK-064 independently testable.

The implementation plan must begin by mapping the actual repository modules and existing verification/identity/execution authorities. It must not assume the conceptual TypeScript signatures above already exist or fit the repository.

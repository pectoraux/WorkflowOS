# WORK-044 — Adaptive Execution Router

Status: READY
Architecture: frozen v1.0 authority model + forward adaptive-execution architecture (§33.3/§33.4)
Dependencies: WORK-032, WORK-033, WORK-043

## Objective

Implement the adaptive execution router that recommends or automatically selects among eligible native/API and external candidates using benchmark outcomes, quality, reliability, cost, latency, human-intervention requirements, and user/project preferences.

The router is a SELECTION layer only. It consumes the authoritative WORK-043 eligibility verdict and MUST NOT reinterpret, weaken, or bypass hard constraints.

## Governing contracts

- WORK-043 is the authoritative HARD eligibility gate.
- Eligibility MUST be evaluated BEFORE ranking.
- Benchmark evidence is a ranking signal, never an eligibility override.
- Native and external execution remain first-class execution modes.
- Provider capability MUST NOT be deliberately reduced to equalize benchmark outcomes.
- `/workflows` remains the workflow-state authority.
- `/verification` remains verification/evidence authority.
- `/github` remains GitHub authority.
- `/agents` remains execution/provider gateway authority.
- `/execution-policy` owns eligibility/selection policy but MUST NOT become a second workflow or authorization system.

## Scope

1. Build an explicit routing input model over already-eligible candidates.
2. Consume WORK-043 verdicts without duplicating its constraint evaluation logic.
3. Rank eligible candidates using benchmark evidence and selection dimensions defined by the forward architecture.
4. Support deterministic ranking with documented tie-breaking.
5. Respect project/user preferences after hard constraints and benchmark quality.
6. Support recommendation mode and automatic-selection mode as distinct caller intents without changing authoritative workflow state.
7. Return an inspectable routing explanation containing the selected candidate, ranked alternatives, and the ranking signals used.
8. Preserve native/external parity: either mode may win when eligible and evidence supports it.
9. Add regression protection proving an ineligible high-quality candidate can never outrank an eligible candidate because it is removed before scoring.

## Out of scope

- Multi-agent roles/delegation/intelligence (WORK-045..047)
- New provider adapters
- New benchmark methodology (WORK-032)
- New eligibility constraints (WORK-043)
- Frontend Unified Execution UX (WORK-050)
- Workflow state transitions or merge/review authority
- Credential storage or provider-specific secrets
- Deliberately degrading provider capabilities

## Acceptance Criteria

### W044-AC01 — Eligibility precedes ranking

Every candidate presented to the ranking function has already passed WORK-043 eligibility. The ranking layer cannot receive or score an ineligible candidate through the public routing path.

Evidence: architecture/static test + integration test.

### W044-AC02 — Hard constraints cannot be overridden by quality

A candidate with superior benchmark quality but an active WORK-043 blocking reason is never selected or ranked ahead of an eligible candidate.

Evidence: integration regression test.

### W044-AC03 — Deterministic ranking

Given identical eligible candidates, benchmark evidence, policy, and preferences, repeated routing produces the identical ordered result and selection.

Evidence: deterministic regression test.

### W044-AC04 — Ranking dimensions are explicit

The router documents and applies the approved ranking dimensions: quality/benchmark outcome, reliability, cost, latency, human intervention, and user/project preferences. No hidden provider-specific ranking rule exists.

Evidence: unit + static architecture test.

### W044-AC05 — Native and external remain first-class

No ranking rule intrinsically prefers native or external execution. With equivalent evidence and preferences, mode choice is determined by explicit input/evidence rather than hard-coded bias.

Evidence: paired native/external regression tests.

### W044-AC06 — Capability is not artificially equalized

The router does not modify, truncate, or downgrade a provider's capability set to make benchmark outcomes comparable. Capability differences are supplied by provider/eligibility inputs and only used as hard constraints where WORK-043 requires them.

Evidence: static architecture test.

### W044-AC07 — Preferences are applied only after hard eligibility

User/project preferences may influence ordering among eligible candidates but cannot resurrect blocked candidates or bypass subscription, quota, rate-limit, security, privacy, policy, availability, or capability constraints.

Evidence: integration regression test.

### W044-AC08 — Recommendation vs automatic selection are explicit

Recommendation mode returns an inspectable ranking/explanation without mutating workflow state. Automatic selection returns the selected eligible candidate but still does not directly mutate authoritative workflow state.

Evidence: API/service integration tests.

### W044-AC09 — Explainability

Routing output identifies the selected candidate, relevant ranked alternatives, eligibility status, major ranking signals, and the reason the selected candidate won among eligible options.

Evidence: contract + regression tests.

### W044-AC10 — Failure-safe behavior

If ranking evidence is insufficient or inconsistent, the router fails deterministically according to documented policy and never falls back to an ineligible candidate.

Evidence: regression test.

### W044-AC11 — No parallel eligibility engine

The router MUST consume the existing WORK-043 eligibility contract and MUST NOT introduce another hard-constraint evaluator.

Evidence: static architecture test.

### W044-AC12 — No authority leakage

The router MUST NOT own workflow state transitions, authorization decisions, verification state, GitHub merge behavior, or provider credentials.

Evidence: static architecture test.

### W044-AC13 — Tenant/project scoping

All routing inputs and persisted/read evidence remain tenant/project scoped through existing authoritative boundaries. Cross-tenant evidence cannot affect ranking.

Evidence: PostgreSQL integration test.

### W044-AC14 — Stable tie-breaking

When ranking dimensions are equal, the router uses a deterministic documented tie-breaker that does not depend on object/hash iteration order or nondeterministic database ordering.

Evidence: repeated integration test.

## Required implementation evidence

- Unit tests for ranking math/order and deterministic tie-breaking.
- Static architecture tests proving the router depends on WORK-043 rather than duplicating constraints.
- PostgreSQL integration tests for tenant/project scoping and evidence retrieval.
- Regression tests proving blocked-but-high-quality candidates cannot win.
- API/service tests for recommendation and automatic-selection modes.
- Typecheck and lint clean.
- Full repository regression suite clean.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- changing the WORK-043 hard-constraint semantics;
- adding provider-specific hard-coded ranking preference;
- weakening native/external parity;
- mutating workflow state directly from the router;
- introducing a second eligibility/authorization engine;
- inventing a new authoritative benchmark ledger;
- changing the frozen architecture version.

## Definition of Done

- WORK-044 acceptance criteria have objective evidence.
- All required tests pass on CI.
- Architecture invariants pass.
- PR contains only WORK-044 scope.
- Independent Architect Review approves the PR.
- PR is merged.
- WORK-044 is then marked VERIFIED before WORK-045 becomes eligible.

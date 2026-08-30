# WORK-065 — Repository Mapping + Real-Browser Evidence

Status: evidence (a durable architecture/engineering evidence artifact under
the repository's existing governance/validation/evidence taxonomy). This
artifact is **evidence**, not normative and not authoritative: it records
what was empirically observed + the repository-mapping rulings that shaped
the implementation. It does not directly mutate normative or authoritative
state.

Provenance: produced by the WORK-065 implementation agent (the architect's
2026-08-30 implementation instruction after the WORK-064 finalization
`f9ba02f`). The implementation is on branch `feat/work-065-browser-validation-agent`;
NOT merged; NOT verified — the architect's review and the merge gate remain
the only completion event (§34.8/ADR-0007).

---

## 1. The authority split (the validation-substrate decision)

WORK-065 is the EXECUTION MECHANISM for ValidationJourneys declared under
WORK-064's authority. The split is:

```text
WORK-064 (Continuous Product Validation)
    the domain/model authority — ValidationJourney, EffectPolicy,
    TestIdentity, Environment, ExpectedObservation, Evidence
        ↓ declares (admitValidationRun / finalizeValidationRun /
          mapValidationOutcomeToVerification)
WORK-065 (this Work Order)
    the synthetic browser execution mechanism
        ↓ executes under (the declared EffectPolicy, enforced at
          execution time — fail closed)
the existing Execution Authority (the ONE execution boundary; the browser
agent is a tool-runtime consumer, not a second execution authority)
        ↓ observes into
the EXISTING /verification authority (evidence is mapped through its public
attachEvidence boundary — claim authority, server-side classification)
        ↓
the EXISTING /reviews authority (architect review remains the merge gate)
```

The browser agent does NOT decide:
- whether a test is authoritative (that is `/verification`);
- whether architecture is correct (that is `/architecture`);
- whether a release should ship (that is the release authority);
- whether code should change (that is `/work-items`, via WORK-068);
- whether a Work Item should be created (that is WORK-068).

It executes and observes.

## 2. Repository mapping (the implementation rulings)

### 2.1 Location

`backend/src/browser-validation/` — application-layer capability OUTSIDE
`src/modules/` (the §34 benchmark / execution-policy / orchestration /
agent-roles / continuous-validation precedent; NOT the 18th frozen module).
The frozen module set stays at 17.

### 2.2 The browser abstraction (WORK-036 reuse — NO second framework)

Repository inspection proved the canonical browser infrastructure is
`backend/src/platform/tools/browser-tool-executor.ts` (WORK-036): the
`BrowserToolExecutor` + the neutral `BrowserDriver` PORT
(`open`/`click`/`type`/`extract`/`screenshot`). The browser validation agent
CONSUMES the `BrowserDriver` port directly — it is the same port
`BrowserToolExecutor` wraps. NO second browser automation framework is
introduced.

The Playwright-backed driver adapter (`internal/playwright-browser-driver.ts`)
is the ONE place browser-automation libraries appear in the repository. It
implements the existing `BrowserDriver` port. The static-architecture
invariant (c) pins this: playwright appears ONLY in the driver adapter; no
puppeteer/CDP anywhere in the domain.

### 2.3 The WORK-064 consumption (never reimplementation)

The agent CONSUMES the `ContinuousValidationService` (WORK-064) for:
- admission (`admitRun`) — the agent never admits itself;
- finalization (`completeRun` → `finalizeValidationRun`) — the agent never
  determines health; the finalization boundary independently derives the
  match (PR #86 correction 3 — the agent's asserted `matched` is verified,
  never trusted) and the typed outcome;
- evidence mapping (`mapOutcomeToVerification` → `/verification.attachEvidence`)
  — the agent never constructs a parallel evidence store.

The static-architecture invariant (d) pins this: the domain imports
`admitRun`/`completeRun`/`mapOutcomeToVerification` and does NOT reimplement
the admission/finalization vocabulary.

### 2.4 The effect-policy enforcement (the load-bearing invariant)

The agent enforces the declared EffectPolicy at EXECUTION TIME (before every
action), not merely at admission. The classification is deterministic + closed:
- navigate / extract / screenshot → `read` (admitted under every non-FORBIDDEN
  policy);
- click / type → `mutation` (admitted under SAFE_MUTATION + ISOLATED_MUTATION
  only; rejected under READ_ONLY with a typed `effect_policy_violation`).

FORBIDDEN rejects EVERY action before execution — the browser agent performs
no forbidden actions (the architect-approved safe mechanism is the WORK-064
admission contract, NOT a browser-execution path). ISOLATED_MUTATION requires
the synthetic identity's tenant to match the environment's isolated tenant
(cross-tenant rejection is defense in depth — the WORK-064 admission boundary
already verifies it; the agent re-verifies before the mutation executes).

The static-architecture invariant (m) pins the enforcement in source.

### 2.5 The TestIdentity (presented, never minted)

The agent presents a `TestIdentitySource` to the WORK-064 admission boundary
(an unauthenticated visitor, or an already-authenticated synthetic machine
principal). It NEVER mints credentials, creates users, or impersonates a
human. The closed machine-credential provider set is `['apikey']` (WORK-002;
WORK-063's future runtime extends it). A human interactive principal is
REJECTED as a TestIdentity (the load-bearing discrimination — proven in
agent-execution.test.ts §10).

### 2.6 The no-second-authority matrix (static-architecture invariants)

14 static-architecture invariants pin the no-second-authority matrix:
(a) the domain exists + is NOT a frozen module;
(b) imports only allowed surfaces (relative continuous-validation barrel,
    @platform/*, @modules/auth + @modules/verification barrels, playwright
    [driver adapter ONLY], node:*);
(c) NO second browser automation framework;
(d) consumes the WORK-064 authority (never reimplements it);
(e) consumes the existing BrowserDriver port (WORK-036);
(f) NO second identity authority (binds, never mints);
(g) NO second verification authority (no criterion evaluation, no parallel
    evidence store);
(h) NO code mutation / PR merge / review approval / workflow transition;
(i) NO autonomous scheduling (WORK-066 owns triggers);
(j) NO signal/WorkItem creation, NO progressive release (WORK-067..070);
(k) NO durable persistence / migration (migrations stay at 58);
(l) NO secrets;
(m) the effect-policy enforcement is pinned in source;
(n) the app.ts wiring is pinned (DefaultBrowserValidationAgent constructed
    from the WORK-064 service; exposed on AppDeps; production does NOT launch
    a browser unguarded).

### 2.7 Production wiring (fail closed)

`app.ts` constructs `DefaultBrowserValidationAgent` with
`continuousValidationService` and NO driver (`driver: undefined`). Production
fails closed: every call records `environment_error` (never a silent no-op).
The `PlaywrightBrowserDriver` adapter is the explicit binding point for the
future architect-authorized production browser driver — it is NOT wired today
(no production browser is authorized). The static-architecture invariant (n)
pins that `app.ts` does NOT construct `PlaywrightBrowserDriver` (no unguarded
browser launch).

## 3. Real-browser evidence (the verification obligation)

The real-browser integration test
(`tests/browser-validation/real-browser-execution.test.ts`) launches a REAL
Chromium browser (Playwright) against a tiny local HTTP server serving a
known HTML page, and drives the `DefaultBrowserValidationAgent` through the
`PlaywrightBrowserDriver` adapter. It proves:

1. **the happy path** — navigate + extract the heading against a real browser
   → `healthy`; every observation carries the full run→journey→step→env→time
   provenance chain; the evidence mapping into `/verification` ran once with
   `claim` authority + `pass` result (healthy → pass); the evidence reference
   binds back to the existing authority's row.
2. **the selector miss** — an extract whose selector does not match against a
   real browser → the observation is explicitly MISSING (`actual: null`) →
   `validation_failure` (never healthy).

The fake-driver unit tests (`agent-execution.test.ts`, 14 tests) prove the
adversarial failure semantics deterministically:
- browser unavailable → `environment_error`;
- FORBIDDEN policy → `effect_policy_violation` (NO action executed);
- mutation under READ_ONLY → `effect_policy_violation` (partial execution);
- selector miss → `validation_failure` (actual: null);
- timeout → `environment_error`;
- missing observation → `validation_failure`;
- rejected admission → no run + no evidence;
- identity binding (unauthenticated null principal; human principal rejected);
- evidence mapping failure → run preserved + evidence null;
- no second verification authority (agent calls only `attachEvidence`);
- deterministic outcomes.

The effect-policy enforcement + plan construction tests
(`effect-policy-enforcement.test.ts`, 15 tests) prove the enforcement gate +
the closed action classification + the plan-validation rules.

## 4. Scope confirmation (what was NOT pulled in)

WORK-066 (Validation Scheduling & Change Triggers), WORK-067 (Engineering
Signal & Regression Correlation), WORK-068 (feedback-to-Work-Item
automation), WORK-069 (progressive release), WORK-070 (architecture-fitness
automation), and the customer-product dogfooding experiment are NOT pulled
into scope. The browser agent exposes NO scheduling, NO signal emission, NO
Work Item creation, NO progressive-release decisions. The static-architecture
invariants (i) + (j) pin this.

WORK-071, WORK-072, WORK-073, WORK-074 are NOT touched (their activation
state is unchanged).

## 5. Verification summary (on the implementation branch)

- WORK-065 browser-validation suite: 31 tests (15 enforcement/plan + 14
  agent execution + 2 real-browser) — all green.
- WORK-064 continuous-validation suite: 135 tests — unchanged, all green.
- static-architecture: 818/818 (14 new WORK-065 invariants + 804 existing).
- typecheck: 0 errors. lint: 0 errors (2 pre-existing warnings in
  work-032-benchmark.spec.ts, untouched).
- governance:status: exit 0 (WORK-065 recognized as in_flight on branch
  feat/work-065-browser-validation-agent).

NOT merged; NOT verified — the architect's review and the merge gate remain
the only completion event (§34.8/ADR-0007).

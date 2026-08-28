# WORK-046 — Multi-Agent Delegation

Status: READY
Architecture: frozen v1.0 authority model + forward multi-agent intelligence direction (§33.9)
Dependencies: WORK-034, WORK-036, WORK-044, WORK-045

## Objective

Introduce a provider-neutral DELEGATION capability: a bounded multi-agent plan for **one existing Work Item** that assigns WORK-045 roles to execution units, coordinates their dependencies and sequencing, and executes every unit through the EXISTING execution boundary with heterogeneous native/external execution.

WORK-046 is a COORDINATION slice. The delegation layer is **coordination, not authority**:

```text
Work Item
   │
   └── Delegation Plan
         ├── Role A   (WORK-045 role catalog)
         ├── Role B
         ├── Role C
         └── ...
               │
               ↓
        existing ExecutionService
               │
        existing Sessions
               │
        existing Workspaces
               │
        existing Verification
               │
        existing Review
```

It does not implement agent intelligence (WORK-047), a second workflow engine, a second execution engine, a provider router, an eligibility evaluator, or any new authority.

## Governing contracts

- `/workflows` remains the workflow-state authority. A Work Item has ONE authoritative workflow; delegation NEVER mutates workflow state.
- `/agents` remains the execution/provider gateway authority. Every delegated execution is submitted through the EXISTING `ExecutionService.submit()` (built by the EXISTING `ExecutionTaskService`); there is NO second execution engine, no second AgentGateway, no provider implementation in the delegation layer.
- `/execution-policy` (WORK-043) remains the hard eligibility/selection policy authority. Delegation does not evaluate eligibility.
- WORK-044 remains the routing authority. Delegation does not rank or select among candidates.
- WORK-045 remains the role authority. Delegation CONSUMES the closed role catalog (`AgentRoleCatalogService`); it never redefines role semantics, never authors role definitions, and pins the historical `(roleId, roleRevision)` reference at plan creation (W045-AC10).
- `/verification` and `/reviews` remain the verification/review authorities. Delegation never evaluates evidence or reviews.
- One Work Item, one plan identity per logical plan: `(workItemId, planKey)` is the durable idempotent plan identity.
- ONE execution identity per delegated execution: every dispatch attempt references exactly one existing `wfos_executions.execution_id`; retries allocate a NEW attempt with a NEW execution identity while the logical unit identity and its role assignment stay stable.
- Native and external execution remain first-class: a plan may mix native and external units for the same logical Work Item.
- Delegation state is COORDINATION DATA, never a second Work Item lifecycle. Delegation may have internal coordination state (plan/unit/attempt records), but it must not quietly become a second Work Item state machine.

## Pre-implementation architectural checkpoint (REQUIRED before implementation starts)

This is the first work item developed under the WORK-051 governance model (the
architecture-checkpoint process is itself under review on PR #52; until that
machinery merges, this checkpoint is delivered as this documented conformance
matrix — evaluated against the proposed design BEFORE implementation — plus the
executable static invariants in the implementation PR, which serve as the PR
conformance checkpoint).

The proposed delegation design must preserve, and the implementation must
prove structurally:

| # | Preservation requirement | Structural mechanism in the design | Executable proof |
|---|---|---|---|
| P1 | ONE Work Item | A plan is bound to exactly one `work_item_id` (FK); every unit's execution is built by the EXISTING `ExecutionTaskService` for THAT Work Item | migration FK + static invariant (no second work-item authority; no work-item writes) |
| P2 | ONE workflow authority | Delegation code contains NO workflow-state vocabulary, no transition map, no `wfos_workflow_executions`/`wfos_workflow_transitions` SQL, no WorkflowEngine access | static invariant: no hidden lifecycle state |
| P3 | ONE execution identity per delegated execution | `wfos_delegation_attempts.execution_id` is UNIQUE and references the existing execution record; the dispatch protocol submits each attempt exactly once through `ExecutionService.submit` with a deterministic `dispatchIdempotencyKey` (`delegation-unit-<unitId>-attempt-<n>`) | migration constraints + two-actor convergence tests |
| P4 | EXISTING role catalog | Units pin `(roleId, roleRevision)` resolved through `AgentRoleCatalogService.resolveRole` at plan creation; unknown roles fail closed; the delegation layer contains no role definitions | static invariant (consumes the catalog, never redefines it) + fail-closed tests |
| P5 | EXISTING execution policy | Delegation imports nothing from execution-policy; it performs no eligibility evaluation; capability declarations are consumed by the EXISTING boundaries at execution time | static invariant (no execution-policy imports/evaluation) |
| P6 | EXISTING routing | Delegation imports nothing from execution-routing; it performs no ranking/selection; provider validation mirrors the existing route pattern (registry-backed), not a router | static invariant (no execution-routing imports) |
| P7 | EXISTING verification | Delegation never imports /verification and never evaluates evidence | static invariant |
| P8 | EXISTING review | Delegation never imports /reviews and never produces review outcomes | static invariant |

The PR conformance checkpoint (static invariants in the implementation PR)
additionally looks for FORBIDDEN DUPLICATION:
- no second execution engine (no AgentGateway/provider implementation/registry in the delegation layer; exactly ONE `ExecutionService.submit` call site);
- no second role catalog or role-authoring surface;
- no second eligibility/routing engine;
- no second workflow/lifecycle engine ("no hidden lifecycle state");
- no new authority tables for execution history (delegation tables are coordination data referencing EXISTING identities);
- no scheduler (drive is explicit; no timers/cron/background loops).

## Scope

1. A durable, provider-neutral `DelegationPlan` for one existing Work Item: bounded unit list, each unit assigned a WORK-045 role (identity + revision pinned), a mode (`native`/`external`), a provider/model, and dependencies on other units in the same plan.
2. Idempotent plan creation: the same delegation request (same `(workItemId, planKey)`) converges on ONE authoritative plan; concurrent creation never duplicates units.
3. A coordination service that: validates the plan against the role catalog (fail closed), validates the dependency graph (acyclic; dependencies refer to units in the same plan), dispatches ready units (all dependencies succeeded) through the EXISTING `ExecutionTaskService` + `ExecutionService`, observes attempt outcomes through the EXISTING execution record (the outcome authority), and exposes structured plan/unit/attempt state.
4. Failure, retry, interruption, and partial completion: failed units are retryable (a NEW attempt with a NEW execution identity; the unit + role identity stable); interruption cancels pending units without touching in-flight executions; partial completion leaves the plan recoverable.
5. Heterogeneous execution: native and external units in one plan for the same Work Item.
6. Crash-safe dispatch: the attempt intent is durable BEFORE submission; a re-drive after a crash converges (observe-or-resubmit) without a duplicate logical execution.
7. A bounded HTTP surface (create/get/drive/retry/interrupt) behind the existing project authorization, with provider validation mirroring the existing execution route.
8. Real PostgreSQL two-actor regressions for the concurrency claims (below) and static architecture invariants for the boundary claims.

## Out of scope

- Agent Intelligence / learned role selection (WORK-047)
- Adaptive routing or new ranking logic (WORK-044)
- Eligibility evaluation (WORK-043)
- A second workflow engine or ANY Work Item lifecycle authority
- A second execution engine, session engine, or workspace engine
- New provider adapters
- Verification/review semantics
- Authorization/permission engine
- GitHub merge/CI authority
- Credential/secret storage
- Autonomous scheduling (timers/cron/background loops) — drive is explicit
- Multi-Work-Item orchestration (a plan is bounded to ONE Work Item)
- Frontend delegation UX

## Acceptance Criteria

### W046-AC01 — One plan identity per delegation request

Creating the same delegation request twice (same `(workItemId, planKey)`) returns the SAME authoritative plan — same plan id, same unit set. Two concurrent creators converge on one plan with no duplicate units.

Evidence: real-PG two-actor integration test.

### W046-AC02 — WORK-045 roles consumed, never redefined

Every unit carries `(roleId, roleRevision)` resolved through the existing `AgentRoleCatalogService`; unknown roles fail closed with a typed error; the delegation layer contains no role definitions and redefines no role semantics.

Evidence: integration tests + static architecture test.

### W046-AC03 — Existing execution boundary preserved

Every delegated execution is submitted through the existing `ExecutionService.submit()` on a task built by the existing `ExecutionTaskService` for the SAME Work Item. There is exactly one submit call site in the delegation layer; no provider/gateway is imported or implemented.

Evidence: static architecture test + integration tests (execution records carry the Work Item id).

### W046-AC04 — One execution identity per delegated execution

Each attempt references exactly one existing execution identity (`execution_id` UNIQUE per attempt); the dispatch idempotency key is deterministic per logical attempt; a crashed dispatch re-drive converges on ONE execution (no duplicate logical execution).

Evidence: migration constraints + crash/convergence integration tests.

### W046-AC05 — Retry preserves identities

Retrying a failed/unresolved unit allocates a new attempt (new execution identity) while the unit identity, its role identity, and its role revision stay stable.

Evidence: integration test.

### W046-AC06 — Dependencies and sequencing coordinate without lifecycle authority

A unit dispatches only when all its dependencies have succeeded; dependency cycles and cross-plan dependencies fail closed at plan creation; sequencing never mutates (or even reads as an authority) workflow state.

Evidence: integration tests + static architecture test.

### W046-AC07 — Heterogeneous native/external execution

One plan may contain native and external units for the same logical Work Item; native units complete synchronously through the existing native path; external units reach the existing handoff flow and stay in flight until their existing ingestion path terminalizes them.

Evidence: integration test.

### W046-AC08 — Failure, partial completion, interruption, recovery

A failed unit does not fail the plan (the plan stays recoverable); units depending on a failed unit stay pending; an interrupted plan cancels pending units without touching in-flight executions; retry after failure resumes the plan.

Evidence: integration tests.

### W046-AC09 — No hidden lifecycle state

The delegation layer declares NO workflow-state vocabulary, NO transition map, NO engine, and writes no workflow tables. Its coordination statuses (`active/completed/abandoned` for plans; `pending/dispatched/succeeded/failed/unresolved/cancelled` for units) are structurally disjoint from the frozen WorkflowState set.

Evidence: static architecture test (negative invariants).

### W046-AC10 — Structured state for WORK-047

The durable plan/unit/attempt records expose structured state (role pinning, dependency sets, per-attempt outcomes and details) sufficient for later intelligence to analyze without becoming an authority.

Evidence: integration tests asserting the structured records.

### W046-AC11 — Authorization + provider validation mirror the existing surfaces

The HTTP surface is project-authorized (`project.read`/`project.write`); native providers/models and external providers are validated against the existing registry exactly like the existing execution route; delegation adds no authorization or provider-selection semantics.

Evidence: route wiring + static architecture test.

### W046-AC12 — No scheduler

No timer, cron, queue consumer, or background loop drives delegation; every drive is an explicit call.

Evidence: static architecture test.

## Required two-actor PostgreSQL regressions (real PostgreSQL, two independent connections)

1. Same delegation request → ONE authoritative plan (concurrent creators converge).
2. Concurrent execution-unit creation/dispatch → no duplicate logical units or attempts.
3. Retry after crash → convergence (both crash windows: before record creation → re-submit; after record creation → observe).
4. Partial failure → recoverable plan.
5. Role identity → stable across retries.
6. Native/external mix → same logical Work Item.

## Required implementation evidence

- Unit/integration tests for plan validation (unknown role, cycle, cross-plan dependency, missing provider/model) — all fail closed with typed errors.
- The six two-actor regressions above.
- Static architecture invariants: the P1–P8 preservation matrix + the forbidden-duplication checks (including "no hidden lifecycle state").
- Typecheck and lint clean.
- Full repository regression suite clean on real PostgreSQL.

## Migration numbering note

This branch numbers its migration `0057_*` although `main`'s last migration is
`0051_*`: the pending WORK-051 branch (PR #52) already carries migrations
`0052`–`0056`. Numbering WORK-046 at `0057` keeps BOTH merge orders clean
(migrations apply in filename order; `0052`–`0056` are reserved for the
WORK-051 branch).

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a new workflow state, transition, or engine;
- mutating workflow/verification/review state from the delegation layer;
- a second execution engine, provider, or gateway;
- redefining or authoring role semantics;
- evaluating eligibility or ranking candidates;
- an autonomous scheduler;
- a new authoritative persistence model for execution history;
- multi-Work-Item orchestration;
- changing the frozen architecture version.

## Definition of Done

- W046 acceptance criteria have objective evidence.
- All required tests pass on CI.
- Architecture invariants pass (including "no hidden lifecycle state").
- PR contains only WORK-046 scope.
- Independent Architect Review approves the implementation PR.
- Implementation PR is merged.
- WORK-046 is then marked VERIFIED before WORK-047 becomes eligible.

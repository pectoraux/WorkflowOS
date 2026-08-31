# WORK-068 — Feedback → Governed Work Items

Status: IN FLIGHT — activated by the architect on 2026-08-31 (the WORK-068
implementation instruction; the hard WORK-067 edge is SATISFIED — WORK-067
is COMPLETE + FINALIZED on main, `bde33cc` via PR #103, the WORK-067
post-merge finalization) and implemented on branch
`feat/WORK-068-feedback-conversion` (see the activation record appended
below; the original Work Order contract below is preserved, not rewritten).
The completion remains gated on the architect's review + merge (§34.8/
ADR-0007 finalization follows the merge).

Issued by: the research-driven v1.1 evolution (the continuous product
validation roadmap). This Work Order establishes the feedback-to-governed-
work-item conversion model — it does NOT implement runtime code. Activation
requires the architect's authorization and is recorded in
`spec/development-state/program-state.json` (this change records none).

Dependencies: WORK-067 (Engineering Signal & Regression Correlation — the
advisory signal source this Work Order converts into governed work). That
dependency edge is now SATISFIED — WORK-067 is COMPLETE (implemented on
branch feat/WORK-067-signal-regression-correlation, merged by the
architect as `bde33cc` via PR #103 on 2026-08-31T18:30:23Z, squash-merged
at the approved head `0fe9c48` — the post-#104 reconciliation head, the
tree identical — and finalized per §34.8/ADR-0007 by the WORK-067
post-merge finalization; the ADVISORY correlation layer is on main at
backend/src/engineering-signals/). WORK-068 is therefore
DEPENDENCY-ELIGIBLE and remains PLANNED, NOT activated, NOT started — the
architect's authorization is required. Existing
authority consumed: `/work-items` (the ONE Work Item authority, established
in v1.0; this Work Order feeds it, never duplicates it).

Downstream: WORK-069 (Progressive Release & Runtime Validation) and
WORK-070 (Continuous Architecture Fitness) consume the governed Work Items
this Work Order produces.

## Objective

Convert validated engineering signals into governed engineering work —
WITHOUT creating a second Work Item model, a second planning authority, or a
parallel work-intake that competes with the existing `/work-items`
authority.

The existing Work Item authority remains authoritative. This Work Order is
the CONVERSION LAYER that turns advisory signals into proposed Work Items
which then enter the existing `/work-items` authority through its existing
intake.

## The canonical flow

```text
Engineering Signal (WORK-067 — advisory, provenance-bound)
    ↓
assessment (severity, scope, blast radius)
    ↓
deduplication (against existing open Work Items)
    ↓
priority (relative to the existing backlog)
    ↓
Work Item (through the EXISTING /work-items authority —
          never a parallel intake)
    ↓
the existing governance lifecycle (architecture checkpoint,
agent execution, verification, architect review, merge)
```

## Explicit prohibitions

WORK-068 must NEVER become:

- a **second Work Item authority** — the existing `/work-items` authority
  remains the ONE Work Item authority; this Work Order produces PROPOSED
  Work Items that enter through the existing intake;
- a **second planning authority** — the existing continuous development
  planner (WORK-040) remains the ONE planning authority; this Work Order
  feeds it, never replaces it;
- a **second workflow authority** — Work Item lifecycle transitions stay
  in `/workflows`;
- a **silent autonomous Work Item creator** — any conversion is a governed
  decision (the same stop-condition discipline as WORK-046/062/066); a
  signal does not automatically become a Work Item without assessment;
- a **code-mutation authority** — Work Items this Work Order proposes still
  go through the full governance lifecycle before any code change.

## Required invariants

1. The existing `/work-items` authority remains the ONE Work Item authority.
2. A signal becomes a proposed Work Item through assessment, deduplication,
   and priority — never through silent autonomous creation.
3. Each proposed Work Item preserves provenance to its originating signal.
4. A proposed Work Item enters the existing `/work-items` intake; it does
   not bypass the intake.
5. The existing continuous development planner (WORK-040) remains the ONE
   planning authority; this Work Order feeds it, never replaces it.
6. A proposed Work Item still goes through the full governance lifecycle
   (architecture checkpoint, agent execution, verification, architect
   review, merge) before any code change.

## Required proof (verification obligations of the future implementation)

The future implementation must prove, with objective evidence:

1. **no second work-item authority** — a proposed Work Item enters the
   existing `/work-items` intake (static architecture invariant + runtime
   discrimination);
2. **no silent autonomous creation** — a signal does not automatically
   become a Work Item without assessment (discrimination-proven);
3. **provenance preservation** — each proposed Work Item records its
   originating signal(s) (no free-floating proposals);
4. **deduplication** — a signal that duplicates an existing open Work Item
   is deduplicated, not converted into a second Work Item;
5. **no workflow bypass** — a proposed Work Item goes through the full
   governance lifecycle before any code change (no shortcut);
6. **mutation/discrimination** — removing the no-second-authority boundary,
  the provenance binding, or the no-silent-autonomous-creation rule makes
  the corresponding test FAIL.

## Scope

Allowed: the feedback-to-governed-Work-Item conversion model (assessment,
deduplication, priority, provenance); the contract that the existing
`/work-items` authority remains authoritative; the required proofs above.

Forbidden: the signal correlation model (WORK-067), the progressive release
(WORK-069), the architecture fitness model (WORK-070), the existing
`/work-items` authority, the existing planning authority (WORK-040), the
existing workflow authority. Forbidden for THIS change: any runtime code at
all (this task delivers the Work Order only).

## Parallel-execution metadata

```yaml
parallelEligibility: conditional
parallelConflicts:
  - surfaces:
      - spec/architecture/v1.1/
      - spec/development-state/dependency-state.json
    reason: the v1.1 evolution package — concurrent authors must coordinate.
  - migrations: []   # no schema migration in this Work Order
  - authorities:
      - /work-items   # the ONE Work Item authority — consumed, never duplicated
      - /workflows    # the ONE workflow authority — consumed, never duplicated
    reason: the Work Order CONSUMES these authorities; it must not duplicate
      them.
  - dependencies:
      - WORK-067   # the advisory signal source this Work Order converts
    reason: WORK-067 must be complete before its signals can be honestly
      converted into governed Work Items.
protectedSurfaces:
  - spec/architecture/v1.1/dogfooding-model.md
  - spec/work-orders/WORK-068.md
```

An Architect LLM may mechanically determine the state of WORK-068 as:
`READY` when WORK-067 is complete; `BLOCKED` while WORK-067 is
unimplemented; `PARALLEL-SAFE` with WORK-053..061, WORK-064..066, WORK-069..070
(different surfaces); `CONFLICTING` with any future Work Order that authors
a second Work Item, planning, or workflow authority.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second Work Item, planning, or workflow authority;
- silent autonomous Work Item creation without assessment;
- a Work Item that bypasses the existing `/work-items` intake;
- changing the frozen v1.0 architecture version.

## Definition of done

- The feedback-to-governed-Work-Item conversion model is persisted in
  `spec/architecture/v1.1/dogfooding-model.md`.
- All required invariants hold with objective evidence (the required proofs
  above, including mutation/discrimination tests).
- Static architecture invariants for the no-second-authority matrix pass.
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-068 scope; independent Architect Review approves;
  WORK-068 is marked VERIFIED before WORK-069/070 become eligible on it.

## Activation record (2026-08-31 — appended by the implementation)

**Activated by the architect** (the WORK-068 implementation instruction).
Repository truth at activation: `origin/main` = `8985dab` (the WORK-067
post-merge finalization, PR #105 MERGED); 60/60 recorded work orders
complete, 15/15 finalized, NOTHING in flight, no active handoffs; the hard
dependency WORK-067 complete+finalized (`bde33cc` via PR #103) — the
advisory signal source exists on main. Branch:
`feat/WORK-068-feedback-conversion` (grown from `8985dab`). Recorded in
`spec/development-state/program-state.json` (status `in_flight`, the
entry-level surfaces/dependencies/assurance profile + the resumption
handoff).

### The implemented conversion model

The domain lives at `backend/src/feedback-conversion/` (the
application-layer pattern — NOT an 18th frozen module; the WORK-064/065/
066/067 precedent), composed in `app.ts` as `feedbackConversionService` on
`AppDeps` (NO route surface — the future governed consumers wire the drive
surfaces).

- **The canonical flow** (`DefaultFeedbackConversionService.convertSignal`
  — the explicit governed invocation, never autonomous): signal read
  through the WORK-067 **public** `findSignal` boundary → the tenant/
  project scope assertions (typed mismatch errors — mandatory boundaries)
  → the deterministic **assessment** (severity interpretation, scope/blast
  radius over the recorded occurrence evidence, recurrence, the backlog
  context read through the authority — never invented evidence) →
  **deduplication** against existing open Work Items (the deterministic
  `SIGWI-<sha256-24>` conversion key over tenant + project +
  logicalFailureKey; the environment is DELIBERATELY absent — the same
  logical failure across environments is ONE engineering problem that
  converges on ONE Work Item) → the conversion-relative **priority**
  (P0..P3 + discrete factors + the explanatory backlogRelation naming the
  WORK-040 planner as the owner of all backlog ordering) → the PROPOSED
  Work Item created through the **EXISTING `/work-items` public intake**
  (`WorkItemRepository.create` — the single creation path, the WORK-040
  planner precedent; the existing `UNIQUE(architecture_version_id,
  work_item_id)` DB constraint is the persistence-level fence; a
  unique-violation re-queries and CONVERGES, never a duplicate) → the
  append-only **decision record** (the `FeedbackConversionRecordRepository`
  PORT + the in-memory adapter — NO migration; 59 migrations on main,
  none added; the durable binding point is a documented future ACR at the
  same port).
- **The decision vocabulary** (closed): `proposed` (the first conversion
  of a logical problem — the Work Item is created through the intake with
  `metadata.feedbackConversion` embedded), `deduplicated` (an OPEN
  equivalent Work Item exists — the signal converges; its provenance is
  APPENDED to the item's contributing signals through the authority's
  public update path, append-only; NO second Work Item), and
  `recurrence-recorded` (the logical problem was COMPLETED in this
  architecture version and is observed again — the recurrence is recorded
  with the completed item's reference; NO create, NO mutation of the
  completed item's evidence; the architect/planner owns the follow-up).
- **Provenance** (invariant 3): the metadata payload preserves the full
  reconstructable chain — observation → engineering signal (id +
  fingerprint preserved exactly as WORK-067 defines them) → assessment →
  conversion decision → the EXISTING Work Item — never a hash alone, never
  inferred from timestamps/titles/commits/URLs. The advisory origin is
  declared honestly (`provenanceNote`: planning input, never confirmed
  truth; the full governance lifecycle still applies).
- **Fail-closed typed errors** (§12): `FEEDBACK_SIGNAL_NOT_FOUND`,
  `FEEDBACK_SIGNAL_EMPTY`, `FEEDBACK_SIGNAL_TENANT_MISMATCH`,
  `FEEDBACK_SIGNAL_PROJECT_MISMATCH`,
  `FEEDBACK_ARCHITECTURE_VERSION_NOT_FOUND`,
  `FEEDBACK_ARCHITECTURE_VERSION_NOT_IN_PROJECT`,
  `FEEDBACK_ASSESSMENT_INVALID`, `FEEDBACK_INTAKE_UNAVAILABLE`,
  `FEEDBACK_CONVERSION_IDENTITY_CONFLICT`,
  `FEEDBACK_CONVERSION_RECORD_CONFLICT`. Failures are NEVER transformed
  into "no work needed / healthy / nothing to do / success".
- **The authority boundary matrix** (16 static-architecture invariants,
  897/897 total): ONE Work Item authority (create ONLY through the public
  intake; no second repository/model/store/controller; no direct SQL);
  no silent autonomous creation (no timers/intervals/cron/queues/polling —
  the explicit invocation is the only entry point); the existing intake
  (never bypassed); the planner remains authoritative (WORK-040 — the
  priority is relative + explanatory only); the full governance lifecycle
  remains intact (no workflow transitions, no implementation starts, no
  PR creation/merge, no approvals, no checkpoint/verification/review
  bypasses); no unauthorized migration; no route surface; the
  one-conversion-layer rule; the unique-violation convergence discipline.

### Proof status (on the branch at this writing)

- 76 domain tests (identity 9, assessment 9, priority 9, deduplication 12,
  provenance 7, failure-semantics 9, mutation/discrimination 6, dogfooding
  acceptance 5, concurrency/idempotency 6, module composition 4, helpers) —
  ALL green.
- 5 real-PG two-actor integration proofs on the embedded PostgreSQL
  harness (the UNIQUE-constraint fence under true concurrency: two
  equivalent signals → one proposed + one deduplicated + exactly ONE work
  item row with BOTH contributing signals; the same-signal concurrent
  re-delivery; the different-problem independence; the recurrence path on
  real PG; the record-port keyed-uniqueness contract on a test-schema
  table) — ALL green.
- The 6 required mutation/discrimination proofs (§15): bypass-the-intake,
  bypass-assessment, strip-provenance, remove-dedup, remove-scope,
  autonomous-path — each proven BY the discriminating assertion.
- The 5 dogfooding-derived acceptance cases (§16): the realistic
  logical-failure-key fixtures (dependency-blocked admission,
  project-access creation-path, agent-output visibility, GitHub
  installation linking) — CONTEXT ONLY, none of the findings absorbed.
- Static architecture 897/897; typecheck clean; the full verification
  battery re-runs on the final head before the PR.

### Known limitations (honest)

- The decision-record log is the in-memory adapter (the documented
  non-durable boundary — NO migration is authorized by this Work Order;
  the durable binding point is a future ACR at the same port; the
  PostgreSQL keyed-uniqueness contract is proven by the real-PG suite).
- No public route surface exists (the conversion is invoked through the
  service boundary by future governed consumers; §14: only the activated
  contract could require one — it does not).
- The recurrence-recorded outcome records but does not act (by design: the
  architect/planner owns the follow-up decision).

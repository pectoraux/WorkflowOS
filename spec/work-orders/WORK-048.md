# WORK-048 — Developer Workbench

Status: IN FLIGHT — on branch `feat/work-048-developer-workbench` (off main@e2b665c —
the merged WORK-047, whose post-merge finalization §34.8/ADR-0007 is carried by this
same change). Derived from the architect's authorization; this document is the
governing work order.
Architecture: frozen v1.0 authority model (the workbench is a CONSUMER, never an authority)
Dependencies: WORK-040 (continuous development planner), WORK-041 (maintenance and
project health engine), WORK-042 (cross-mode execution handoff), WORK-044 (adaptive
execution router). Consumes the public contracts of WORK-043/045/046/047, WORK-015/016
(verification/reviews), WORK-008/009 (github/workflows), WORK-020/021 (audit/notifications),
WORK-022 (the existing web application shell it extends).

## Objective

Implement the **Developer Workbench** as the primary human-facing engineering
workspace: a single place that exposes the AUTHORITATIVE state of

```text
Project → Overview → { Work Graph, Work, Executions, Changes,
                       Verification, Reviews, Deployments,
                       Maintenance, Activity }
```

The workbench answers, without requiring the developer to navigate unrelated
subsystems:

```text
What project am I in?        What is happening?
What should happen next?     Why?
Which Work Items are active? Which agents are executing?
What changed?                What is verified?
What is blocked?             What needs review?
What failed?                 What requires attention?
What maintenance is emerging? What deployment state exists?
```

It should make WorkflowOS feel like an engineering operating system rather than
a collection of administrative screens.

## The non-negotiable architectural rule

**The frontend MUST NOT recreate authoritative state.** The workbench is a
consumer of backend authorities:

```text
Backend authorities → API/read models → Developer Workbench
```

NOT `Developer Workbench → frontend state → backend`. The frontend must not
implement: workflow state machines, authorization, execution state, verification
state, review state, dependency truth, or architecture truth. Frontend state may
cache/query server data (TanStack-Query-style fetching or plain fetch hooks per
existing conventions); it must not become authoritative. All project access
remains server-authorized; cross-project data leakage must be impossible
(demonstrated by regression).

WORK-047 intelligence recommendations and WORK-044 routing results MAY be
displayed but must remain visibly and semantically RECOMMENDATIONS:

```text
✓ "Agent Intelligence recommends Provider A"
✗ "Provider A selected"     ← only an authoritative execution decision may say this
```

## Governing contracts (the architect's authorization, verbatim intent)

- **API strategy**: prefer consuming existing endpoints. Existing contracts cover:
  project identity/health (`GET /projects/:id`, `/projects/:id/runtime`,
  `/repositories`), work item details (`GET /work-items/:id`, work orders,
  pr-associations, dependencies), workflow (`getState`, `history`,
  `merge-readiness`, `next-work-item`), executions (per item), verification
  (runs/evidence/mappings per item), reviews (findings/result per item),
  deployments (`/runtime/deployments`), maintenance (`/maintenance/signals`,
  `/maintenance/health` — version-scoped), planning
  (`/planning/recommendations`), activity (`/audit`, `/notifications`), and the
  advisory chain (`/execution/recommendation`, `/execution/routing/recommendation`,
  `/agent-intelligence/{execution,delegation}`).
- **The genuine gaps** (unavailable by any composition of existing contracts
  without N+1 walks or reverse-edge scans that do not exist): the project work
  graph (nodes + dependency edges + per-node unsatisfied dependencies + workflow
  states) and the project-scoped rollups (executions, pr-associations,
  verification runs, reviews). These become ONE thin read-model route file
  (`backend/src/api/routes/workbench.route.ts`), READ-ONLY, `project.read`,
  server-side project resolution, reusing the OWNING repositories/services via
  `listForProject` read additions — no second business domain, no new tables, no
  migration (the last migration stays `0057`).
- **Authorization**: every new endpoint resolves project scope server-side and
  reuses `requireProjectAuthorization` — never URL-ID trust, never client-side
  inference. At least one explicit regression proves a user/project cannot read
  another project's Workbench state.
- **Architecture preservation**: no new workflow/work-item/execution/
  verification/review persistence; no duplicate GitHub truth; no second
  architecture representation; no frontend scheduler, policy engine, or
  recommendation engine. Deployments consume the existing runtime authority;
  maintenance consumes the existing WORK-041 authority (the future maintenance
  UX is WORK-049 — NOT implemented here); no WORK-049/WORK-050/Change Programs/
  runtime feedback/architecture fitness/adaptive assurance/self-hosting
  automation.
- **UX**: engineering-flow optimized — `What needs attention? → Why? → Open Work
  Item → Inspect execution → Inspect changes → Inspect verification → Inspect
  review`. Use the existing design system and application shell (WORK-022
  conventions: `AppShell`, `PageHeader`, domain components, Tabs); progressive
  disclosure; clear status; actionable next steps; explainability; error
  clarity; missing backend data rendered as unknown/unavailable — never
  invented; failed API requests never fabricate success.

## Adversarial verification matrix (all required)

1. The Workbench cannot read another project (tenant isolation, real PostgreSQL).
2. The frontend cannot authoritatively mutate workflow state through hidden UI state.
3. Recommendation ≠ decision (a displayed recommendation never becomes a selection).
4. Backend state changes are reflected after refresh/re-query.
5. Stale UI state cannot override server truth.
6. Failed API requests do not fabricate success state.
7. Missing backend data is represented as unknown/unavailable, not invented.
8. Work Item details remain consistent with authoritative backend records.
9. PR/revision shown by the Workbench is the authoritative GitHub-derived identity.
10. Verification results shown by the Workbench come from `/verification` (the
    verification authority), never from frontend evaluation.

## Static architecture assertions (WORK-048 describe block)

No frontend workflow/authorization/execution/verification/review authority; no
provider SDKs or direct database access from the frontend; no hidden second Work
Item store; no hidden second GitHub authority; the workbench route is READ-ONLY
(GET only) and authorizes server-side; the `listForProject` additions are
SELECT-only reads on the owning repositories. Discriminating tests where
practical.

## Required verification

typecheck; lint; frontend unit tests; frontend integration tests; API tests for
the new endpoints (including the tenant-isolation regression); static
architecture checks; relevant backend integration tests; full regression suite;
real PostgreSQL for backend semantics that depend on persistence/security;
browser E2E for the Workbench flows. Failures are investigated and reproduced,
never labeled "pre-existing" without discrimination.

## Out of scope (explicitly)

WORK-049 (Project Health/Maintenance UX), WORK-050 (Unified Execution UX),
Change Programs, runtime feedback, architecture fitness, adaptive assurance
implementation, self-hosting automation, any new persistence or migration.

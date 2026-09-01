# V2-002 Dogfooding Evidence

**Work Order:** V2-002 — Workflow Repository + Immutable Versioning
**Classification:** user-facing repository capability (repository/version/fork/install path)
**Validation type:** required feature-boundary dogfooding experiment (dogfooding-protocol.md)
**Status:** COMPLETE / EVIDENCE PERSISTED WITH THE WORK ORDER DELIVERY
**Base revision:** ed82bbc6774a8bb6d052e7a0618e867b796dde32
**Implementation revision:** recorded in the delivery PR head (branch `work/v2-002-workflow-repository`)

## Required experiment

Per `dogfooding-protocol.md` (V2-002 row) and Work Order V2-002:

> Create a workflow, edit it, create an immutable version, fork it, install it,
> and execute it. Verify old installations remain pinned.

## Experiment design

- **Surface/host:** the real backend product path — the real Fastify server
  (`buildServer`) with the real auth plugin, real PostgreSQL (PGlite — real
  PostgreSQL compiled to WASM — locally; the same harness selects real `pg`
  in CI when `WORKFLOWOS_DATABASE_URL` is set), real V1 identity/membership
  consumed through the `/organizations` and `/users` public contracts, and
  the real V2-002 `/v2` repository API over HTTP (`server.inject` — real
  Fastify HTTP semantics without a long-running listener).
- **Workflow under test:** `daily-pr-triage` — a realistic workflow document
  (schedule trigger + GitHub PR-triage steps). Every step capability
  identifier is checked against the canonical `V2-CTRL-003` protocol registry
  (`github.repository.read`, `github.pull_request.create`,
  `github.pull_request.merge`).
- **Task:** create → commit v1 → edit → commit v2 → install BOTH versions
  (two tenants pin different immutable versions) → fork → install the fork →
  publisher ships v3 → EXECUTE the installation path and verify every
  installation still resolves its originally pinned immutable version.
- **"Execute" scope:** V2-002 owns repository/install persistence, not the
  execution engine (V2-005+). Execution is exercised as the installation
  execution path an executor consumes: `GET /v2/installations/:id/execution-target`
  resolves the installation to its pinned immutable version, and the executor's
  integrity check (the resolved content recomputes to the pinned digest) is
  performed — exactly the resolution contract the later runtime consumes.

## Observed outcome (real run, one-off harness over the same stack)

```text
create:             workflowId=b222c159-a822-4e26-b73c-e1cad9ad3a62
                    owner=d438ac73-1b22-4126-94e2-8451b90b0fda
                    tenant=b9cc4d41-356a-49f7-a969-ce7293f89d56
                    visibility=public protocol=2.0 http=201
version v1:         id=wfv_d8c662b335984f1a538667bc861b7d6e453956ebe1c0f412e26bc1b064a7b4dd
                    digest=89c41b53cefb95fd28146495096e0b351dd854cdc31ae30eb9ab5374b7a12632
                    parent=null http=201
edit → v2:          id=wfv_220b7b5bec55ed1a135b960bd673696b05908d8f6faf0d7067a715c528d3343b
                    digest=c3d23a908d3de4da4c3f8af52c0c90a3539ac685d80d868e1631c590279e94a1
                    parent=wfv_d8c662…7b4dd http=201
v1 unchanged:       byte-identical=true digest-recompute=true
install orgA→v1:    installationId=3499d3d3-… pinned=wfv_d8c662…7b4dd status=enabled http=201
install orgB→v2:    installationId=c5a5166c-… pinned=wfv_220b7b…3343b http=201
fork:               forkWorkflowId=17df05ff-… owner=4ef6d052-…
                    forkedFrom={"workflowId":"b222c159-…","workflowVersionId":"wfv_220b7b…3343b"}
                    forkVersionId=wfv_7f6ee0384de3f75076c8e2573a85adcb4b4ba90077bd9abef780c32d914566f8
                    sameDigest=true http=201
install fork:       installationId=fbf04c38-… pinned=wfv_7f6ee0…566f8 http=201
publisher v3:       id=wfv_667d8d2c9a56103a2b559897d006abca538acbcfb17289a258466636bc130f05
execute orgA:       resolved=wfv_d8c662…7b4dd (= v1, ≠ v3) digestRecompute=true http=200
execute orgB:       resolved=wfv_220b7b…3343b (= v2, ≠ v3) digestRecompute=true http=200
execute fork:       resolved=wfv_7f6ee0…566f8 (= fork initial, ≠ v3) digestRecompute=true http=200
RESULT: PASS (wall-clock: 3638ms)
```

**Expected outcome:** editing creates a NEW immutable version (old version
byte-identical); installs pin exactly the requested versions; the fork is a
new workflow identity with preserved provenance and identical content; and
after the publisher ships v3, every installation still resolves its ORIGINAL
pinned version with the content recomputing to the pinned digest.

**Result: PASS.** All expected outcomes observed; no defects found at the
feature boundary.

**Failure classification:** none (PASS).

**Resulting action:** V2-002 is eligible for Architect review/merge. No
corrective Work Order required from this experiment.

## Evidence references

- Reproducible regression harness (runs in CI on every PR):
  `backend/tests/integration/v2-002/dogfooding-experiment.integration.test.ts`
  (steps 0–7 mirror this experiment; 8 tests, all green at the delivery head).
- Full V2-002 battery: `backend/tests/integration/v2-002/` (repository
  lifecycle/permissions/visibility, immutable versions, install pinning,
  fork provenance, dogfooding) + `backend/tests/unit/v2-002/` (canonical
  content addressing, registry conformance) — 63 tests.
- One-off real-run harness used for the observed values above (not committed;
  same real stack as the integration battery): create → edit → version →
  fork → install → execute, asserting byte-identical history, pinned-version
  resolution and digest recomputation.

## Safety

No production-destructive action was performed. The experiment uses an
isolated throwaway PostgreSQL instance (per-run PGlite database), synthetic
tenants/users, and a workflow document with registry-conformant capability
identifiers. No secrets, no real external systems, no long-running servers.

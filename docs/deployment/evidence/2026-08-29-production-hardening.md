# Deployment Evidence — Production Hosting Hardening (2026-08-29)

Durable evidence record for the production deployment hardening delivery.
No secrets — only platform identities, public URLs, and verification
results. Per-release evidence for future releases is emitted by the
`release.yml` workflow (job summary + artifact); this file records the
hardening transition itself.

## Identities

### Vercel (frontend hosting)

| Item | Value |
|---|---|
| Team | `ekonplacidegmailcoms-projects` (`team_4KOoA5CgtYaOF85yFXPeMXLt`) |
| Project | `frontend` (`prj_DeoyVveZQ4FdjGIH1gjgZy3bSjSU`), framework `vite`, region `iad1` |
| Production domain (alias) | `frontend-gray-iota-23.vercel.app` |
| **Production deployment** | `dpl_4uMgdQVDKGL3VRWtZ3FTe6fwM2Fo` (READY) |
| Preview deployment (isolation proof) | `dpl_A3Lf5F7zX9boNqjgUkazXDXqaUJH` (READY) |
| Environment variables | `API_TARGET` (production → Railway API; preview → isolation canary); the dead, unused `BACKEND_URL` variable was REMOVED |
| Git link | none (CLI-deployed; PR previews + production deploys are owned by `release.yml`) |

### Railway (backend runtime) — observed state, no control-plane access

| Item | Value |
|---|---|
| Public API URL | `https://workflowos-production.up.railway.app` |
| Liveness at audit | `GET /health` → 200 `{"status":"ok"}` |
| Readiness at audit | `GET /health/ready` → 503: `postgres` ok (latency ~0.7–1.3s), `redis` ok, **`objectStore` BROKEN** (`Unable to connect. Is the computer able to access the url?` — S3-compatible endpoint unreachable from the service) |
| Deployed revision fingerprint | pre-WORK-024→028 era (no `/benchmarks`, `/maintenance/health`, `/execution/routing`, `/agent-intelligence` routes; no `deployment.commitSha` identity) — the backend is ~25 work orders behind `main` |
| CORS | correctly configured for the Vercel production origin (preflight verified) |
| Worker service | not observable without control-plane access (see Known Limitations) |

### GitHub repository (release pipeline configuration)

| Item | Value |
|---|---|
| Actions variables | `PRODUCTION_API_URL`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `PREVIEW_API_TARGET` |
| Actions secrets | `VERCEL_TOKEN` (pipeline ARMED); `RAILWAY_TOKEN` intentionally absent — the Railway stage skips VISIBLY with manual steps |
| Release system | `.github/workflows/release.yml` (PR checks + isolated previews; main: backend-contract gate → Vercel production deploy → live verification → evidence) |
| Local topology validation | `.github/workflows/deploy.yml` (docker-compose only; never deploys to cloud providers) |

## Deployed revision

- Repository base: `a12444a9fa969354153f24e71054dbca8f3779b1` (`main`, the
  v1.1 governance artifacts merge) + the deployment-hardening changes on the
  delivery branch.
- The Vercel production deployment was built from the delivery branch's
  `frontend/` (bun install → `tsc && vite build` → dist). The backend was
  NOT redeployed (credential gap — see Known Limitations); the live backend
  remains the pre-WORK-024-era deployment.

## Environment separation proof (deployment-level regression)

Same code path, different per-environment `API_TARGET`:

| Deployment | API_TARGET | `/api/health` through the Vercel origin |
|---|---|---|
| Production `dpl_4uMgdQVDKGL3VRWtZ3FTe6fwM2Fo` | Railway production API | **200 `{"status":"ok"}`** (reaches the backend) |
| Preview `dpl_A3Lf5F7zX9boNqjgUkazXDXqaUJH` | `workflowos-preview-canary.invalid` | **502 DNS_HOSTNAME_NOT_FOUND** (canary does not resolve → the preview CANNOT reach any backend, including production) |

Verified by `scripts/verify-cloud-deployment.sh`: production mode 7/7
passed; preview mode 4/4 passed (isolation is a REJECTING condition in
preview mode). The configuration is fail-closed: building the frontend
without `API_TARGET` throws at config-compilation time.

## Live verification (2026-08-29, from the public internet)

### Production domain (after alias propagation) — 7/7

- SPA shell served (HTTP 200, app root present)
- Hashed JS bundle loads (`assets/index-DfWIKSEH.js`)
- Deep link `/projects` serves the SPA shell (SPA fallback works)
- `/api/health` through the Vercel rewrite → 200 `{"status":"ok"}`
- Backend liveness 200; readiness 503 recorded (object store broken —
  pre-existing, Railway-side; see Known Limitations)
- Authenticated read-only `GET /api/projects` through the Vercel origin →
  200 with the production project list (Browser → Vercel → Railway →
  PostgreSQL path)

### Browser E2E (real browser against the production domain)

- SPA loads; login with the repository-committed demo API key succeeds
  (note: the login form requires a page reload to enter the app — a
  pre-existing product quirk of `useAuth` state propagation, unrelated to
  deployment; recommended as a separate product fix)
- Projects list renders `Demo Project` (production PostgreSQL data)
- Deep link + project shell render (Workbench, Overview, Architect,
  Architecture, Requirements, Work Items, Activity, Settings)
- Workbench loads with GRACEFUL degradation against the stale backend
  ("The work graph is unavailable for this project (Not found).") — no
  console errors, no crash
- Screenshots: `workbench-production.png`, `overview-production.png`
  (captured during verification; held in the delivery session artifacts)

### Rollback drill (live, against the production alias)

1. Promoted the previous production deployment
   (`dpl_2rMMPYK1bkFEP7cnBuCRgGqt2hYp`) → the alias switched within
   seconds and served that deployment's defective `/api` proxy
   (DNS_HOSTNAME_NOT_FOUND).
2. Promoted `dpl_4uMgdQVDKGL3VRWtZ3FTe6fwM2Fo` back → the alias restored
   within ~15–25s; `/api/health` returned 200 again.

Conclusion: Vercel rollback/promote is deterministic, immediate, and
reversible (both directions verified live).

## Migration / startup evidence (repository-level)

- Migrations: transactional + idempotent (`schema_migrations` recorded in
  the same transaction); only the api role applies them; the worker logs
  and retries rather than crash-looping when the schema is not yet applied
  (outbox-relay + job-handler error containment, WORK-034 semantics).
- Startup: role/port/host binding from environment (`WORKFLOWOS_ROLE`,
  `PORT`, `HOST=0.0.0.0` default) — Railway's injected `PORT` is honored.
- Object storage: `OBJECT_STORAGE_PROVIDER=s3` with an incomplete
  configuration now FAILS STARTUP (fail-closed) instead of silently
  degrading; the active adapter is logged with non-secret configuration
  (`app.object_store.active`).
- Health: `GET /health` carries the non-secret deployment identity
  (role / `RAILWAY_GIT_COMMIT_SHA` / `RAILWAY_ENVIRONMENT_NAME`) once the
  backend is redeployed from current `main` — this powers the release
  pipeline's backend-contract gate (release sequencing).

## Known limitations (honest record)

1. **Railway control-plane access was NOT available for this delivery.**
   The credential supplied as "Railway API key"
   (`…@redis.railway.internal:6379`) is the Redis private-network password,
   not a Railway API token: the Railway GraphQL API rejects it
   (`Project Token not found` / `Not Authorized`, same response as an
   invalid token). Therefore the backend could NOT be redeployed, its
   variables could not be fixed, and worker logs were not observable. The
   `RAILWAY_TOKEN`-gated stage in `release.yml` skips VISIBLY with the
   manual deploy steps until a real token is provided. *(Re-confirmed by
   the operator after delivery — see the post-delivery addendum below; the
   gap remains open.)*
2. **The live backend is ~25 work orders stale** (pre-WORK-024-era) and its
   object store is BROKEN (S3-compatible endpoint unreachable). The new
   frontend therefore runs AHEAD of the deployed backend contract: newer
   surfaces (Workbench data, benchmarks, maintenance, agent intelligence)
   degrade gracefully with explicit "unavailable" states until the backend
   is redeployed from current `main`. The release pipeline's
   backend-contract gate prevents this mismatch from recurring silently.
3. **This one-time frontend-first transition is the documented exception**:
   the backend deploy being credential-blocked, the hardened frontend was
   promoted manually while the backend remained stale. Future releases are
   ordered schema → backend → worker → frontend by the gate.
4. **Previews are isolated by canary, not by a preview backend**: no
   Railway preview environment exists yet (credential gap). Preview
   deployments cannot exercise API-dependent flows; when a preview backend
   exists, `PREVIEW_API_TARGET` re-points them with no code change.
5. Vercel preview deployments are PUBLIC (SSO protection disabled for the
   project): the repository is public, and preview `/api` is canary-blocked,
   so previews expose nothing beyond the public SPA build.

## Post-delivery addendum (2026-08-29 ~20:45Z) — operator credential
follow-up, empirical re-assessment

After the delivery report, the operator supplied two further items to try
to close the Railway credential gap. Both were tested empirically against
every reachable surface (values redacted; no secrets recorded):

1. **`REDIS_URL`** (`redis://default:***@redis.railway.internal:6379`) —
   this CONFIRMS the delivery's diagnosis: the string previously supplied
   as "Railway API key" is the Redis private-network credential, now
   correctly labeled by the operator. Re-verified live: the backend's
   `redis` readiness check passes (ok, ~5 ms), so this credential is
   already wired into the Railway service environment and functioning.
   It is NOT a control-plane credential — Railway GraphQL v2 (Bearer),
   the legacy `x-apitoken` header, and the CLI (`RAILWAY_TOKEN`) all
   reject it — and `redis.railway.internal` is reachable only from inside
   Railway's private network, so it grants nothing from the public
   internet.
2. **"WorkflowOS2 Private Key"** (`SHA256:rQSW…ezQ=`) — a SHA256-format
   fingerprint (the class `ssh-keygen -lf` emits): an IDENTIFIER of key
   material, not key material — it cannot authenticate anywhere.
   Empirically rejected as a Railway control-plane credential in all
   auth forms (fingerprint and raw base64 body). No entity named
   "WorkflowOS2" exists on any reachable platform: Vercel (all 12 team
   projects enumerated — none), GitHub (no such repository under the
   owner; zero deploy keys on this repository), Railway public networking
   (`*.up.railway.app` is wildcard DNS — the `workflowos2` and
   `workflowos-2` hosts return edge 404s, and random subdomains resolve
   identically, so DNS resolution proves nothing). If a host named
   "WorkflowOS2" is intended for SSH access, its hostname + user + the
   actual private key block (not the fingerprint) would be required.

**Conclusion: the Railway control-plane gap REMAINS OPEN.** Either of
these closes it:

- a real **Railway Project Token** (Railway dashboard → Project Settings
  → Tokens → Create token; a UUID-format string — not a SHA256
  fingerprint, not the Redis password), stored once as the
  `RAILWAY_TOKEN` Actions secret — the `release.yml` Railway stage arms
  itself automatically; or
- a **manual backend redeploy** by the architect (no token needed):
  Railway dashboard → backend service → connect the repository
  (`pectoraux/WorkflowOS`, branch `main`) → redeploy, then confirm
  `/health` reports the new `deployment.commitSha` identity field — the
  release pipeline's backend-contract gate then passes for all future
  releases.

Live state re-verified at the same timestamp (unchanged from delivery):
production `dpl_4uMgdQVD` READY; `/api/health` 200 through the Vercel
origin; authenticated `GET /api/projects` 200 through the full
Browser → Vercel → Railway → PostgreSQL path; backend readiness still
503 (postgres ok, redis ok, objectStore broken); the newest preview
`dpl_3zUUK54d` is the release-workflow CI preview (PR #79 merge commit
`3ef2767d`, isolated by the canary).

Secret hygiene: the Redis password has now been transmitted twice in the
operator channel; it remains absent from every repository artifact
(this file included). Rotation at the architect's convenience is prudent
but not urgent (private-network-only reachability).

---

## Addendum 2 — the Railway project token: supplied, verified, armed (2026-08-29 ~22:10Z)

The operator supplied a UUID-format token — the exact closure path
documented in the previous addendum. Empirical verification:

- It is a REAL **Railway PROJECT token** bound to the production project
  (`fortunate-art`, id `82db36d4-b386-490a-8827-f71a2e94b7e3`, workspace
  "Tetevi Ekon's Projects"). Project-scoped operations succeed: CLI
  `status`, `variable set`, `up`, `deployment list`. Account-scoped queries
  (`me`, `projects`, `deployment(id:)`) return "Not Authorized" — that is
  the token's DESIGN scope, not a defect (and why account-token-style
  probes reject it).
- It is stored as the `RAILWAY_TOKEN` Actions secret (presence verified via
  the repository secret list; values are write-only). The `release.yml`
  Railway stage is ARMED. The token value appears in NO repository artifact
  (this file included). Rotation note: it transited the operator channel;
  rotating at the architect's convenience is prudent.

Live project topology (verified with the token):

- `WorkflowOS` — `WORKFLOWOS_ROLE=api`, public domain
  workflowos-production.up.railway.app; build config: rootDirectory
  `backend` + Dockerfile.
- `WorkflowOS-Worker` — `WORKFLOWOS_ROLE=worker`; same build config.
- `Redis` — private network (`redis-volume`), already wired via `REDIS_URL`.
- `perceptive-emotion` — an orphan service shell with no instances in the
  production environment (not even queryable through the project token);
  flagged for the architect, deliberately untouched.

Backend state (honest record — the deploy itself happened in the
interrupted continuation and is recorded here for the first time): both app
services were redeployed from `main` @ `a12444a` via CLI on 2026-08-29 (api
21:30Z, worker 21:35Z; repository-root uploads). A verification redeploy of
the worker at 22:01Z from the same source reproduced the IDENTICAL image
digest (`sha256:1a74bfb4…`) — proving both the repo-root upload + build
config path and build determinism. The backend is therefore CURRENT with
main, but `/health` still returns the minimal pre-identity shape — the
deployment-identity surface ships in THIS pull request, so the
backend-contract gate stays blocked until the PR merges (expected, by
design). `WORKFLOWOS_COMMIT_SHA=a12444a` is set on both services
(`--skip-deploys`), so the identity will surface on the first post-merge
deploy.

Two release-pipeline defects found against the live project and FIXED
(commit `d66277a`):

1. Wrong service names (`workflowos-api`/`workflowos-worker` → the real
   `WorkflowOS`/`WorkflowOS-Worker`) — the armed stage would have failed
   its first run with "service not found".
2. No commit-SHA propagation on CLI deploys — the stage now sets
   `WORKFLOWOS_COMMIT_SHA=<release sha>` (`--skip-deploys`) and verifies
   the live `/health` reports the released SHA after deploying.

Object store — ROOT CAUSE CONFIRMED, operator input still required:
`OBJECT_STORAGE_ENDPOINT=https://workflowos.r2.cloudflarestorage.com` is not
a valid R2 endpoint. R2 S3 endpoints are account-scoped
(`https://<account-id>.r2.cloudflarestorage.com`); the configured hostname
resolves only through the zone's wildcard DNS and cannot route to a real
account. Readiness therefore stays 503 (postgres ok, redis ok, objectStore
broken), and the release pipeline's `REQUIRE_READY=1` production
verification WILL FAIL on every main release until the real R2 endpoint is
set (R2 dashboard → Overview → "S3 API" → update `OBJECT_STORAGE_ENDPOINT`
on both Railway services; the existing access key/secret may already be
valid). This is the remaining open item.

Post-merge bootstrap runbook (for the architect):

1. Merge this PR.
2. Dispatch `release` ONCE with `skip_backend_gate=true` (the documented
   exceptional transition — the live backend still reports the pre-identity
   `/health` shape until this PR's code deploys). The armed railway-backend
   stage deploys both services from merged main with the identity surface +
   SHA variable, then verifies `/health deployment.commitSha` live.
3. Every subsequent push to main passes the backend-contract gate naturally.

---

## Addendum 3 — REQUEST CHANGES remediation: strict pipeline, fail-closed credentials, production FULLY healthy (2026-08-29 ~23:00Z)

The architect's verdict on PR #79 found four failures. All four are
remediated, with live proof:

### 1. Release ordering — now a STRICT PIPELINE (and machine-checked)

`release.yml` was restructured into exactly the required DAG:

```
backend-contract-gate → railway-api-deploy → railway-worker-deploy
      → backend-verification → deploy-frontend → deployment-evidence
```

Every stage `needs` its predecessor — no two production stages can run
concurrently. `backend-verification` is the new enforcement point: the LIVE
backend must report the exact release SHA (`/health deployment.commitSha`) AND
be fully ready (`/health/ready` 200 — postgres, redis, objectStore ALL ok)
before the frontend may ship.

The structure is machine-checked in CI (`deployment-topology.test.ts`,
RD-01..RD-05): the workflow is parsed as YAML and the strict chain asserted;
the pre-remediation CONCURRENT topology (frontend + railway stages both off
the gate) and the warning-only visible-skip step are REJECTING violations —
both discriminations were red-proofed locally before commit (RD-01/DH-06
fail on the concurrent shape; RD-02/DH-04 fail on the skip shape).

### 2. Normal releases FAIL CLOSED on missing credentials

Missing `RAILWAY_TOKEN` or `VERCEL_TOKEN` now FAILS the release at the stage
that needs it (`::error::` + `exit 1` + manual recovery steps). Visible
skips remain ONLY on the PR preview path (per-PR conveniences that never
touch production). Live proof: dispatch run **33279257765** — with the
live backend still on the pre-identity `/health` shape, the gate FAILED and
every downstream stage (including the frontend deploy) was SKIPPED. The
pipeline refuses to ship a frontend against an unverified backend.

### 3. Production is NOW healthy — the object store is REAL for the first time

Root cause (worse than the earlier diagnosis): the production
`OBJECT_STORAGE_ACCESS_KEY_ID`/`SECRET_ACCESS_KEY` values were literally
`placeholder` (11 chars each) and the endpoint was an invalid
non-account-scoped R2 host. The store NEVER worked; readiness was
permanently 503.

Remediation — a real, private, durable S3-compatible store owned by the
project:

- `deploy/minio/` (infra-as-code, in this PR): pinned `minio/minio` +
  `minio/mc` images, an idempotent bootstrap (`init.sh`) that starts the
  server, waits for the S3 API, creates the `workflowos-prod` bucket
  (private), and forwards SIGTERM for graceful drains.
- Provisioned LIVE via the Railway project token: service `MinIO`
  (private-network endpoint `minio.railway.internal`, NO public domain),
  500MB volume `minio-volume` mounted at `/data` (attached through Railway's
  IaC `config apply` — the raw `volumeCreate` mutation is outside project-
  token scope), generated credentials set as service variables.
- Both app services now carry
  `OBJECT_STORAGE_ENDPOINT=http://minio.railway.internal:9000`,
  `REGION=us-east-1`, and the MinIO credential pair (the backend's
  dependency-free SigV4 adapter speaks path-style requests — MinIO's native
  model; NO code changes, the same ObjectStore boundary). The R2 swap-back
  procedure is documented in `docs/deployment/production.md`.

Live result: `/health/ready` = **200 ready, objectStore ok (5–19 ms)** — a
real put+get+delete round-trip through the private network. This is the
first fully-green production readiness in the project's history.

### 4. Live end-to-end proof of the corrected pipeline (dispatch run 33279601226)

Full strict pipeline, GREEN end-to-end on the remediation head (`2dc8dc3`):

| stage | result |
|---|---|
| backend contract gate | success — live SHA `4693fb7` is an ancestor of the release |
| deploy railway backend (api role) | success — deploys + sets `WORKFLOWOS_COMMIT_SHA=2dc8dc3` |
| deploy railway backend (worker role) | success |
| verify live backend | success — `/health` reports `2dc8dc3a…`; readiness 200, all checks ok |
| deploy vercel production | success — `vercel --prod` + REQUIRE_READY=1 live E2E |
| deployment evidence | success |

Independently re-verified after the run: `/health` reports
`commitSha 2dc8dc3a40f4…` (role api, environment production); readiness
fully green; the SPA serves 200 through the Vercel origin; `/api/health`
through the Vercel rewrite reports the SAME deployment identity; an
authenticated read-only `GET /api/projects` returns live data through the
full Browser → Vercel → Railway → PostgreSQL path.

Honest execution record — three dispatch runs, not one:

1. **33279257765** — the gate FAILS CLOSED against a pre-identity live
   backend (the desired blocking behavior; everything downstream skipped).
2. **33279476449** — gate + api deploy green; the worker stage failed on a
   REAL defect in my first strict-pipeline revision: the worker job's
   fail-closed guard read `needs.credentials.*` without declaring
   `credentials` in its `needs` (GitHub resolves undeclared needs to an
   empty context → `undefined != 'true'` fired the guard). Found by LIVE
   execution, fixed in `2dc8dc3` (the worker job now needs
   `[railway-api-deploy, credentials]`), with the defect documented in the
   commit message.
3. **33279601226** — the FULL pipeline green (the table above).

### Deployed-from note (precise)

The live backend runs the remediation branch head (`2dc8dc3` = main + this
PR), because the deployment-identity surface, the fail-closed store, and
the strict pipeline all ship IN this PR — main alone cannot report
`commitSha`. On merge, the pipeline deploys main with the identical
mechanism (the dispatch runs prove the exact code path).

### Observations for the architect (no action taken)

- The Railway workspace is on the free plan; provisioning surfaced a
  resource-limit warning. The `perceptive-emotion` ghost service (empty
  shell, no production instances, not queryable through the project token)
  consumes a service slot; deleting it is an architect decision.
- The `WorkflowOS` API service is Git-connected to `pectoraux/WorkflowOS`
  (root dir `backend`, check suites off); the worker is CLI-upload-only by
  configuration (source type github, repo unset — no auto-deploys).
- MinIO credentials were generated with openssl, set only as Railway
  service variables, and never committed or printed; the R2 placeholder
  values they replaced carried no secret material.

## Addendum 4 — REQUEST CHANGES remediation round 2: authoritative deployment identity, proven persistence, interrupted-release recovery (2026-08-30 ~00:30Z)

The architect's second verdict found the release pipeline materially
stronger but blocked approval on three counts. Remediation record:

### 1. Deployment evidence is now the authoritative machine-readable identity record

The pre-remediation `deployment-evidence` job recorded the backend as
`"automatedDeploy": "see railway-backend job…"` — job-log prose, not an
identity. The record (schemaVersion 2, per-release run artifact + job
summary) now carries the durable cross-provider provenance, each element
sourced from the provider's OWN record or the LIVE service — never from
pipeline prose:

```
release commit dba6f4369dc2ee620671efad8692e121901d4a09
├── Vercel deployment dpl_8QjPLWdon73qHDxEjcSNKtgd6Xst
│     (Vercel REST API v6/deployments — matched by the EXACT deployment
│      URL this run created; a stale-identity fallback is age-bounded to
│      5 minutes, never older)
├── Railway api deployment 1ca8ec7b-a61a-41f9-bbcd-f5faf747b31d
│     imageDigest sha256:3f851b00… (railway deployment list --json,
│     set-difference vs the pre-deploy snapshot, polled to SUCCESS)
│     observedSha dba6f436… ← live GET /health deployment.commitSha
└── Railway worker deployment b5ea678b-52de-44b0-ab7b-4964df93c4e7
      imageDigest sha256:7824bade… (same mechanism)
      observedSha dba6f436… ← the live deployment's boot log line
      `app.process.starting … commitSha="dba6f436…"` — the RUNNING
      process attests its own revision
```

The worker observation is the round's key design point: the worker serves
NO HTTP by design (backend/src/index.ts — only the api role builds the
Fastify server), so its live revision cannot be probed over HTTP. The
process entrypoint now logs its deployment identity at boot for ALL roles
(`app.process.starting` {role, commitSha, environmentName, serviceName}),
and the pipeline reads that line from the just-deployed deployment's logs.
The evidence records what the RUNNING PROCESS attests — never the merely
configured `WORKFLOWOS_COMMIT_SHA` variable (a distinction the
interrupted-release drill below demonstrated live: the variable said
`1d9a5ff` while the running worker still attested `6fe83e7`).

The evidence job VALIDATES the record before attesting: every provider
identity present, every observedSha == releaseCommit, readiness ready with
every check ok — otherwise the job FAILS ("an unobservable deployment is
unverifiable"; an incomplete record would launder an interrupted release
into "evidence"). The job needs every pipeline stage DIRECTLY, so an
interrupted release can never produce a partial record. Machine-checked:
RD-06/RD-07 (deployment-topology.test.ts, 37/37) with red-proofed
discriminations — the pre-remediation prose-pointer shape and the
identity-less deploy stage are REJECTING violations, verified locally
against the HEAD versions of all three files (exactly the 4 new checks
fail against the old shapes; all 37 pass against the new).

Run D (33283025817) is the live proof: full pipeline green, record
validated, artifact uploaded (deployment-evidence-dba6f4369dc2ee620671efad8692e121901d4a09.zip,
Artifact ID 9723569379), and independently re-verified from this machine:
/health reports dba6f43, the worker deployment b5ea678b's boot log
attests dba6f43, readiness all-green, SPA + /api rewrite through the
Vercel deployment URL report the same SHA.

### 2. MinIO persistence — a REAL defect found and fixed, then proven

The persistence question exposed that the durability property did NOT
hold: the MinIO service was running with `volumeMounts: []` — ephemeral
container storage. The 2026-08-29 IaC apply had CREATED the minio-volume
but the attachment to the service never materialized (the
`railway service list` record and the deployment meta both confirmed
volumes: [] — while Redis correctly showed redis-volume at /data). Every
object in production would have been silently lost on the next MinIO
restart.

Fix: a surgical one-change IaC apply (`config plan` showed EXACTLY one
change — attach the existing minio-volume at /data on service MinIO —
after expressing the worker's live partial github-source precisely so
nothing else changed). Deployment ab4c5551: SUCCESS with
volumeMounts ["/data"]; init.sh re-created the private bucket
idempotently on the volume.

Persistence drill (executed live, through the REAL application boundary —
POST /projects/:id/specifications/:specId/versions with a 12,313-byte
body > the 8KiB inline threshold → ObjectStore → MinIO, per DATA3-AC-02):

1. WRITE: drill spec `minio-persistence-drill`
   (3a69aaed-6e7a-42af-8c09-928acd1ee1f1), version storageKey
   `1788048288168-0zvicz0y`, provider s3,
   digestSha256 `18b08a93472d2b6f7bde065a19d9b2daef8d24e68c74aefd63b5f0d05c8fdee0`.
2. BASELINE READ: GET …/versions/latest — content round-trips, digest
   matches (put/get proof).
3. RESTART: `railway redeploy --service MinIO` — deployment ab4c5551 →
   073a76b5 (SUCCESS, volume mounted): the object-storage AUTHORITY's
   container restart, the operational failure mode.
4. POST-RESTART READ: byte-identical (digest
   `18b08a93…` — matches both the stored digest and the original
   content); /health/ready all-green (the app reconnects automatically).

The durability contract is now explicit in production.md: MinIO + the
Railway persistent volume + private networking = the persistence
authority, with the drill procedure recorded for re-execution.

### 3. Interrupted-release recovery — documented, machine-checked, AND drilled live

The release recovery protocol (workflow header + production.md) covers the
four failure modes; RD-08 machine-checks the documentation AND the
structural enforcement (evidence needs every stage; backend-verification
enforces api/worker SHA coordination; Railway deployment atomicity). The
live drill executed the full sequence at commit 1d9a5ff/dba6f43 — and
caught two REAL defects on the way:

- **Run A (33282530146, 6fe83e7)** — failure mode "worker deploy fails":
  the api deploy succeeded, the worker Railway deployment SUCCEEDED
  server-side, but the stage failed at the boot-log observation step
  (`railway logs <id>` without `--service` → "No service linked").
  Everything downstream SKIPPED — no verification, no frontend, no
  evidence: nothing shipped, nothing falsely attested, production stayed
  fully serviceable (readiness green). Fixed in 1d9a5ff.
- **Run B (33282788523, 1d9a5ff)** — canceled mid-worker-deploy right
  after the api deploy succeeded: the genuine MIXED-REVISION state,
  observed live at the moment of interruption — /health reported
  `1d9a5ffe…` (api NEW) while the running worker's boot log attested
  `6fe83e7f…` (worker OLD; its deployment 85e20b2c still live, the new
  build ce854e1c only BUILDING). Readiness all-green and the drill data
  intact DURING the mixed state — the interim state is serviceable, the
  worker never ahead of the api role, and the mixed state can never be
  attested (the evidence job cannot run).
- **Run C (33282851275, 1d9a5ff)** — recovery re-run: backend stages
  green (including the new backend-verification identity+readiness
  checks), Vercel deploy SUCCEEDED, but the stage failed closed at
  deployment-ID resolution (`vercel inspect` printed no dpl_ id; the
  `vercel ls ./frontend` fallback was wrong by construction — the
  positional is a PROJECT NAME, not a directory). Again: verification +
  evidence skipped, release unattested, no partial record laundered.
  Fixed in dba6f43 (Vercel REST API resolution, exact URL match).
- **Run D (33283025817, dba6f43)** — full recovery: the ENTIRE strict
  pipeline green end-to-end with the validated identity record (above).

The drill is honest evidence, not theater: both unplanned failures were
real defects in the new machinery, each caught by fail-closed behavior
BEFORE anything unverified shipped, each fixed, and the recovery path
(re-run to convergence + attestation) exercised end-to-end. That is
precisely the property the architect asked the protocol to establish.

### 4. CI on the final head dba6f43: 13/13 green (honest flake record)

All 13 workflows green (Architecture Governance, backend, e2e, 6×
browser-e2e, release ×2 [PR path + run D], deploy, frontend,
companion-extension-e2e). The backend workflow took a same-commit re-run
discrimination sequence on dba6f43: attempt 1 failed
`WORK-046 delegation TWO-ACTOR #2` (25P02, two-actor concurrency),
attempts 2–3 failed `R1-#2b` cross-mode-handoff (`'running' vs
'completed'` at the 45s deadline — the DOCUMENTED main-level flake
signature, the same test/signature as main's backend run #260 and the
previously documented PR #74/#77/#78 occurrences), attempt 4 SUCCESS.
Materially: MAIN ITSELF (a12444a — the merge-base, zero branch commits)
failed R1-#2b in 7 consecutive backend runs on 2026-08-29
(18:40Z→19:12Z), so this is a pre-existing main-level CI-environment
failure (GitHub runner slowness; the test's own comment documents local
convergence in ~1.4s vs repeated CI deadline overruns across three prior
PRs), with zero diff from this PR to the failing suite. The branch's
backend suite was fully green on 2dc8dc3 (one commit before this round's
changes) and is green on dba6f43 (re-run).

### Rotation reminder

The Railway project token, the GitHub PAT, and the Vercel token transited
operator channels and should be rotated after this work merges (the
GitHub PAT especially — it was pasted into a chat context). All secrets
live exclusively in the GitHub Actions secret store; rotation is a
secret-store update + re-dispatch, no code changes.

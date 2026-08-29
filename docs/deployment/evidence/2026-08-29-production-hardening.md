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

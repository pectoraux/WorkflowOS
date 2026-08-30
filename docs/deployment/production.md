# Production Deployment — WorkflowOS

This document covers the complete production deployment of WorkflowOS to
Vercel (frontend) + Railway (backend API + worker) + Neon (PostgreSQL) +
Railway Redis + Cloudflare R2 (object storage) + GitHub App (webhooks).

## Architecture

```
Vercel (frontend SPA)
   ↓ HTTPS
Railway API (Fastify, WORKFLOWOS_ROLE=api)
   ↓
Neon PostgreSQL (authoritative)
   ↓
Railway Redis (queue/locks/cache, non-authoritative)
   ↓
Cloudflare R2 (object storage)
   ↓
GitHub App (webhooks → /webhooks/github)
   ↓
Railway Worker (WorkerHost, WORKFLOWOS_ROLE=worker)
```

## Prerequisites

Before starting, you need accounts on:
- [Neon](https://neon.tech) — PostgreSQL
- [Railway](https://railway.app) — backend container hosting + Redis
- [Cloudflare](https://dash.cloudflare.com) — R2 object storage
- [GitHub](https://github.com) — GitHub App for webhooks
- [Vercel](https://vercel.com) — frontend hosting

## 1. Neon PostgreSQL

1. Create a Neon project → select your region.
2. Create a database (e.g. `workflowos`).
3. Copy the **pooled** connection string from the Neon dashboard.
4. Save it as `DATABASE_URL` — you'll set it in Railway.

```text
DATABASE_URL=postgresql://USER:PASSWORD@...pooler...neon.tech/workflowos?sslmode=require
```

## 2. Railway — backend + Redis

1. Create a Railway project.
2. **Add Redis**: + Add → Database → Redis. Railway gives you a `REDIS_URL`.
3. **Deploy the API service**:
   - + Add → GitHub Repo → select `pectoraux/WorkflowOS`
   - Root directory: `backend`
   - Railway detects `backend/Dockerfile`
   - Set `WORKFLOWOS_ROLE=api`
   - Set environment variables (see below)
   - Railway assigns a public URL (e.g. `https://workflowos-api.up.railway.app`)
4. **Deploy the Worker service**:
   - + Add → GitHub Repo → same repo
   - Root directory: `backend`
   - Same Dockerfile
   - Set `WORKFLOWOS_ROLE=worker`
   - Same env vars (DATABASE_URL, REDIS_URL, etc.)
   - The worker does NOT need a public URL

### Railway environment variables (API + Worker)

```text
DATABASE_URL=<Neon pooled connection string>
REDIS_URL=<Railway Redis internal URL>
OBJECT_STORAGE_DIR=/data/objects
WORKFLOWOS_ROLE=api   # or worker
PORT=3001             # API only
HOST=0.0.0.0
LOG_LEVEL=info
CORS_ORIGIN=https://app.yourdomain.com
WORKFLOWOS_GITHUB_WEBHOOK_SECRET=<your-webhook-secret>
```

## 3. Object storage — private-network MinIO (production) / R2 (optional swap)

The production topology ships with **its own S3-compatible object store**: a
private-network, volume-backed **MinIO** service inside the Railway project
(`deploy/minio/` — pinned images, idempotent bucket bootstrap, no public
exposure). The backend's dependency-free SigV4 adapter speaks path-style
requests, which is MinIO's native model, so the SAME `ObjectStore` boundary
serves both providers.

**Why MinIO and not R2**: the previous production object-storage config was
never real — placeholder credentials plus an invalid endpoint (a
non-account-scoped `*.r2.cloudflarestorage.com` host) — so readiness stayed
503 forever. A working store was provisioned inside the project the release
pipeline can own end-to-end.

**Live configuration** (set on both `WorkflowOS` and `WorkflowOS-Worker`):

```
OBJECT_STORAGE_PROVIDER=s3
OBJECT_STORAGE_BUCKET=workflowos-prod          # created idempotently on boot
OBJECT_STORAGE_ENDPOINT=http://minio.railway.internal:9000
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_ACCESS_KEY_ID=<MINIO_ROOT_USER>     # generated, never committed
OBJECT_STORAGE_SECRET_ACCESS_KEY=<MINIO_ROOT_PASSWORD>
```

**Operating the MinIO service**:

- Deploy/update: `cd deploy/minio && railway up --service MinIO`
  (the service's code root is that directory; a repo-root upload fails
  visibly by construction — there is no top-level Dockerfile).
- Storage: the `minio-volume` Railway volume mounted at `/data` — durable
  across redeploys.
- Credentials: `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` service variables
  (rotation = rotate the MinIO service vars AND the two app services'
  `OBJECT_STORAGE_*` credentials together, then redeploy).
- The bucket stays private; the service has NO public domain.

**Durability contract (explicit architectural decision)**: production object
storage is `MinIO + the Railway persistent volume + private networking`. The
volume is the persistence authority — objects written before a MinIO
restart/redeploy MUST still be readable after it. This is NOT the same as
readiness ("can put/get succeed now?"); it is the property that previously
persisted verification evidence survives the operational failure modes the
deployment is expected to tolerate. Verify it with the persistence drill:

```bash
# 1. Write a >8KiB specification version through the REAL application
#    boundary (large bodies go to object storage — DATA3-AC-02):
#    POST /projects/<id>/specifications/<specId>/versions  (content > 8KiB)
# 2. Read it back: GET /projects/<id>/specifications/<specId>/versions/latest
#    → content round-trips from MinIO (baseline put/get proof).
# 3. Restart the object-storage authority:
#    railway redeploy --service MinIO -y
# 4. Read it back AGAIN after the redeploy completes: the content must be
#    IDENTICAL (digest match) and /health/ready must report objectStore ok.
```

The drill was executed live on 2026-08-29 (see the deployment evidence
addendum): a >8KiB specification version written before the redeploy was
read back byte-identical after the MinIO container restarted, and readiness
returned to all-green — persistence across the restart failure mode, proven
through the application's own ObjectStore boundary, not just the S3 API.

**Swapping to Cloudflare R2** (unchanged procedure, kept for reference —
use when a real R2 account exists):

1. Cloudflare Dashboard → R2 → Overview → Create bucket
   (`workflowos-prod`) → note the account-scoped S3 endpoint
   (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com` — the account ID is on
   the R2 overview page; an endpoint without it does not route).
2. Manage API Tokens → Create API Token → Object Read & Write → scope to
   the bucket.
3. On BOTH Railway app services set `OBJECT_STORAGE_ENDPOINT` to the R2
   endpoint, `OBJECT_STORAGE_REGION=auto`, and the R2 access key pair, then
   redeploy. No code changes — the ObjectStore boundary is provider-neutral.

> **Note:** The local docker-compose topology keeps the filesystem adapter
> (`OBJECT_STORAGE_DIR=/data/objects`); the S3 adapter is the production
> configuration (fail-closed on incomplete config).

## 4. GitHub App

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Configure:
   - Homepage: `https://app.yourdomain.com`
   - Webhook URL: `https://api.yourdomain.com/webhooks/github`
   - Webhook secret: generate a secure random string
   - Repository permissions: Contents (Read), Pull requests (Read), Checks (Read)
   - Subscribe to events: `pull_request`, `check_run`, `workflow_run`, `push`
3. Save the App ID.
4. Generate a private key (PEM) → save securely.
5. Install the App into your repository/org.

### GitHub env vars (set in Railway)

```text
WORKFLOWOS_GITHUB_WEBHOOK_SECRET=<your-webhook-secret>
GITHUB_APP_ID=<app-id>
GITHUB_PRIVATE_KEY=<pem-content>
```

## 5. Vercel — frontend

The frontend deployment configuration is `frontend/vercel.ts` (programmatic
configuration — DEPLOYMENT HARDENING). It is a Vite SPA build with:

- `/api/(.*)` proxied to the environment-resolved `API_TARGET` origin, with
  the `/api` prefix stripped (same contract as the docker-compose nginx
  proxy and the vite dev-server proxy);
- filesystem serving for static assets, plus an SPA fallback
  (`/(.*)` → `/index.html`) for client-side routing deep links;
- **no** backend business logic, **no** serverless API implementation, and
  **no** secrets.

### Environment separation (CRITICAL)

The API proxy destination is resolved AT BUILD TIME from the per-environment
`API_TARGET` project variable (fail-closed: a build without `API_TARGET`
fails — it never silently deploys a mis-targeted proxy):

- `API_TARGET` (**production**) = `https://workflowos-production.up.railway.app`
- `API_TARGET` (**preview**) = `https://workflowos-preview-canary.invalid`
  — a deliberately non-resolving canary so **preview deployments can never
  reach the production backend** (fail-safe isolation). When a real preview
  backend exists, point this variable at it.

CLI deployments must export `API_TARGET` when invoking `vercel deploy`
(the configuration compiles at the deploy invocation):

```bash
# production
API_TARGET=https://workflowos-production.up.railway.app \
  vercel deploy ./frontend --prod --token=<vercel-token>

# preview (isolated)
API_TARGET=https://workflowos-preview-canary.invalid \
  vercel deploy ./frontend --token=<vercel-token>
```

The release pipeline (`release.yml`) sets these values from repository
variables (`PRODUCTION_API_URL`, `PREVIEW_API_TARGET`) and VERIFIES the
isolation after every preview deployment
(`scripts/verify-cloud-deployment.sh` in `MODE=preview`).

## 6. Custom domains

### API domain (Railway)
1. Railway → API service → Settings → Networking → Generate Domain.
2. Add your custom domain: `api.yourdomain.com`.
3. Add the CNAME record Railway gives you to your DNS provider.

### Frontend domain (Vercel)
1. Vercel → your frontend project → Settings → Domains.
2. Add `app.yourdomain.com`.
3. Add the DNS record Vercel gives you.

## 7. CORS

The backend is configured to accept CORS from the `CORS_ORIGIN` env var.
Set it to your Vercel frontend URL:

```text
CORS_ORIGIN=https://app.yourdomain.com
```

Do NOT use `*` for authenticated production APIs.

## 8. Migrations

The API role runs migrations on startup (the worker skips them to avoid races).
Each migration applies in a transaction that also records it in
`schema_migrations` — idempotent and safely retryable. When the API and
worker start simultaneously (fresh environment), the worker does NOT crash:
its outbox relay sweep and job handlers log errors and retry until the API
finishes applying the schema (the WORK-034 durable-redelivery semantics; see
the deployment-topology test suite). To verify:

```bash
# After the API is running
curl https://api.yourdomain.com/health/ready
# Should return {"status":"ready","checks":{"postgres":{"ok":true},...}}
```

## 9. Bootstrap owner

After the first deployment, provision the initial admin:

```bash
DATABASE_URL=<neon-url> \
WORKFLOWOS_BOOTSTRAP_API_KEY=<your-secure-key> \
bun scripts/bootstrap-production.ts
```

This creates:
- An organization
- An owner user
- An API key (printed to stdout)
- A project

Use the API key to log in to the frontend.

## 10. Health / readiness validation

```bash
# Liveness
curl https://api.yourdomain.com/health
# → {"status":"ok"}

# Readiness (checks PostgreSQL, Redis, ObjectStore)
curl https://api.yourdomain.com/health/ready
# → {"status":"ready","checks":{...}}
```

Railway should use `/health/ready` for deployment probes.

## 11. Smoke test

After deployment, verify the full stack:

```bash
API=https://api.yourdomain.com
KEY=<bootstrap-api-key>
PROJECT=<bootstrap-project-id>

# Health
curl -sS $API/health

# Readiness
curl -sS $API/health/ready

# Auth — project access
curl -sS -H "x-api-key: $KEY" $API/projects/$PROJECT

# Architecture
curl -sS -H "x-api-key: $KEY" $API/projects/$PROJECT/architectures

# Work items
curl -sS -H "x-api-key: $KEY" $API/work-items/$PROJECT/work-orders

# Workflow state
curl -sS -H "x-api-key: $KEY" $API/projects/$PROJECT/workflow/next-work-item

# Audit history
curl -sS -H "x-api-key: $KEY" $API/projects/$PROJECT/audit
```

## 12. Rollback strategy

See **`docs/deployment/rollback.md`** for the complete rollback playbook —
including the Vercel promote/rollback procedure (exercised live against the
production alias: deterministic switch with seconds-level propagation), the
Railway redeploy path, and the migration-irreversibility policy for
destructive schema changes.

## 13. Secret rotation

### API key
1. Run the bootstrap script with a new `WORKFLOWOS_BOOTSTRAP_API_KEY`.
2. The old key remains valid (you can revoke it from the database if needed).

### GitHub webhook secret
1. Generate a new secret.
2. Update the GitHub App's webhook secret in the GitHub UI.
3. Update `WORKFLOWOS_GITHUB_WEBHOOK_SECRET` in Railway.
4. Redeploy the API + worker.

### R2 credentials
1. Cloudflare → R2 → Manage API Tokens → Create new token.
2. Update the R2 env vars in Railway.
3. Redeploy.
4. Revoke the old token.

### Neon database password
1. Neon → Reset password.
2. Update `DATABASE_URL` in Railway.
3. Redeploy.

## Release pipeline (CI/CD)

`release.yml` is THE release system for the cloud topology:

- **Pull requests**: static config checks (`scripts/validate-vercel-config.ts`,
  VC-01..VC-06) + frontend typecheck + an ISOLATED Vercel preview whose
  `/api/*` is verified NOT to reach the production backend. PRs never deploy
  production Railway state.
- **Push to main / workflow_dispatch** — the production release is a STRICT
  PIPELINE (every stage `needs` its predecessor; no two production stages
  ever run concurrently, and a missing credential FAILS the release instead
  of skipping):

  1. **backend-contract-gate** — the live backend's `GET /health`
     `deployment.commitSha` must be a git ancestor of the release (an
     architect-approved exceptional transition can skip ONLY this precheck
     via `workflow_dispatch` with `skip_backend_gate=true`; recorded in the
     run log + evidence).
  2. **railway-api-deploy** — deploys the api role (`railway up --service
     WorkflowOS`); schema migrations run on api-role startup; sets
     `WORKFLOWOS_COMMIT_SHA=<release sha>` on both services so `/health`
     reports the exact release. The stage then reads Railway's OWN
     deployment record (`railway deployment list --json`), polls until the
     release's deployment is `SUCCESS`, and emits the authoritative
     deployment identity (deployment UUID + image digest) for the evidence
     record.
  3. **railway-worker-deploy** — deploys the worker role (`railway up
     --service WorkflowOS-Worker`), captures its deployment identity the
     same way, AND observes the worker's live revision from the deployment's
     boot log (`app.process.starting … commitSha=<sha>` — the worker serves
     no HTTP by design, so its running process is the authority on what it
     executes). An unobservable worker identity BLOCKS the release.
  4. **backend-verification** — the LIVE backend must report the exact
     release SHA (`/health deployment.commitSha`) AND be fully ready
     (`/health/ready` 200 — postgres, redis, objectStore ALL ok), AND the
     worker's observed boot SHA must equal the release SHA (api/worker
     revision coordination — a mixed, uncoordinated backend blocks the
     frontend).
  5. **deploy-frontend** — `vercel deploy --prod` + live production
     verification (`scripts/verify-cloud-deployment.sh`, `MODE=production`,
     `REQUIRE_READY=1`: SPA shell, assets, deep links, `/api` rewrite,
     backend liveness/readiness, authenticated read-only call through
     Browser → Vercel → Railway → PostgreSQL). Resolves the Vercel
     deployment ID (`dpl_…`) for the identity record.
  6. **deployment-evidence** — composes and VALIDATES the machine-readable
     cross-provider identity record (schemaVersion 2; see below); the job
     FAILS if any provider identity is missing or the observed SHAs are not
     coordinated. It needs every pipeline stage DIRECTLY, so an interrupted
     release can never produce a partial record.

  The DAG structure itself is machine-checked in CI
  (`backend/tests/architecture/deployment-topology.test.ts`, checks
  RD-01..RD-08): the pre-remediation concurrent topology, the
  visible-skip-instead-of-fail credential handling, and the
  prose-instead-of-identity evidence shape are REJECTING violations.

### Deployment identity & evidence (machine-readable)

Every release leaves an explicit, machine-readable identity record tying the
durable cross-provider provenance together:

```
release commit ↔ Vercel deployment (dpl_…) ↔ Railway api deployment (UUID)
              ↔ Railway worker deployment (UUID)
```

The record (`evidence/deployment-evidence.json`, uploaded as a 90-day run
artifact + job summary) carries, per provider: the deployment ID from the
provider's OWN deployment record, the image digest (Railway), the URL
(Vercel), and — critically — what the LIVE SERVICES THEMSELVES reported:
the api role's SHA from `GET /health`, the worker role's SHA from its boot
log. The evidence job validates that every identity is present and every
observed SHA equals the release commit before attesting the release: an
incomplete or uncoordinated record FAILS the job ("an unobservable
deployment is unverifiable"). Railway CLI deployments are not
Git-connected — that is exactly why the evidence records Railway's
deployment UUIDs and the SHAs observed from the running services, never a
claim from the pipeline's own logs.

### Release recovery protocol (interrupted releases & mixed revisions)

The complete architecture is `DB/schema → api → worker → frontend`, and the
strict pipeline makes every interruption recoverable by RE-RUNNING the
workflow — all stages are idempotent (the same SHA is re-pinned, the same
image is redeployed, verification re-observes the live services), and
Railway deployments are atomic (a new deployment takes over only after its
build+start succeed, so an interrupted stage's service keeps its previous
healthy deployment). The failure modes:

1. **API deploy fails** — nothing ships: every later stage is skipped via
   the needs-chain, production stays fully on the previous release, the
   frontend is never exposed to an unverified backend. Fix and re-run.
2. **Worker deploy fails / the run is canceled mid-release** — the interim
   state is `api(NEW) + worker(OLD)`. This state is safe and transient: the
   worker is never AHEAD of the api role (the api deploy — which owns schema
   migrations — always runs first), and the release is INCOMPLETE until the
   worker's observed boot SHA equals the release SHA (backend-verification
   enforces this before the frontend can ship). Re-run to converge both
   roles onto the release SHA. To ABANDON the release instead, roll the api
   service back to its previous deployment (`railway redeploy` of the prior
   deployment ID — recorded in the last evidence artifact) so both roles
   return to the same revision.
3. **Restart mid-release** (provider/runner restart during a release) —
   same as (2): the interrupted stage's service keeps its previous healthy
   deployment; the re-run completes the interrupted stage atomically.
4. **api/worker temporarily on different revisions** — observable, bounded,
   and one-directional (worker never newer than api within a release). The
   release protocol's invariant: a release is COMPLETE only when the
   deployment evidence records BOTH roles' observed SHAs equal to the
   release commit AND the frontend deployment — a mixed state can never be
   attested as released.

The protocol is enforced structurally, not just documented: the
deployment-evidence job needs every pipeline stage DIRECTLY (any failed or
canceled stage skips it entirely — an interrupted release cannot produce a
partial record that would launder it into "evidence"), and backend-verification
blocks the frontend on api/worker SHA coordination. The interrupted-release
recovery drill (cancel mid-worker-deploy → observe the mixed state → re-run
→ converge + attest) was executed live on 2026-08-29 — see the deployment
evidence addendum.

`deploy.yml` remains the validation CI for the frozen LOCAL docker-compose
topology — it never deploys to cloud providers and is not a second release
system.

Required repository configuration:

- secrets: `VERCEL_TOKEN`, `RAILWAY_TOKEN` (BOTH required for production
  releases — a missing secret fails the release fail-closed; the Railway
  secret must be a PROJECT token for the production project)
- variables: `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `PRODUCTION_API_URL`,
  `PREVIEW_API_TARGET`

## Object storage hardening

`OBJECT_STORAGE_PROVIDER=s3` FAILS CLOSED: an incomplete S3 configuration
(any of bucket/endpoint/access-key/secret-key missing) throws at startup
instead of silently degrading to the filesystem/in-memory adapter. Startup
logs identify the ACTIVE adapter with its non-secret configuration
(`app.object_store.active`: provider/bucket/endpoint-host for S3) so a
misconfigured store is diagnosable from deploy logs alone. The readiness
probe continues to verify actual reachability (put+get+delete probe).

## Environment variables summary

| Variable | Where | Description |
|---|---|---|
| `DATABASE_URL` | Railway (API + Worker) | Neon PostgreSQL connection string (authoritative) |
| `REDIS_URL` | Railway (API + Worker) | Railway Redis internal URL (non-authoritative: queue/locks/cache) |
| `OBJECT_STORAGE_PROVIDER` | Railway (API + Worker) | `s3` for the S3-compatible adapter (fail-closed on incomplete config) |
| `OBJECT_STORAGE_BUCKET` / `_ENDPOINT` / `_REGION` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | Railway (API + Worker) | S3-compatible object storage — production uses the private-network MinIO service (`http://minio.railway.internal:9000`); Cloudflare R2 is a drop-in swap |
| `OBJECT_STORAGE_DIR` | Railway (API + Worker) | filesystem adapter directory (local/dev topology) |
| `WORKFLOWOS_ROLE` | Railway | `api` or `worker` (same image, two roles) |
| `PORT` | Railway (API) | provided by Railway; the image binds `0.0.0.0:$PORT` |
| `HOST` | Railway | `0.0.0.0` |
| `LOG_LEVEL` | Railway | `info` |
| `CORS_ORIGIN` | Railway (API) | the Vercel production origin |
| `WORKFLOWOS_GITHUB_WEBHOOK_SECRET` | Railway (API + Worker) | GitHub webhook secret |
| `API_TARGET` | Vercel (per environment) | production: the Railway API origin; preview: the isolation canary |

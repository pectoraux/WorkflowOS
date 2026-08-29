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

## 3. Cloudflare R2 — object storage

1. Cloudflare Dashboard → R2 → Overview → Create bucket (e.g. `workflowos-prod`).
2. Manage API Tokens → Create API Token → Object Read & Write → scope to bucket.
3. Save:
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_ACCOUNT_ID`
   - `R2_BUCKET_NAME`
   - `R2_ENDPOINT` = `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

> **Note:** The current production deployment uses filesystem object storage
> (`OBJECT_STORAGE_DIR=/data/objects`). To use R2, set `OBJECT_STORAGE_PROVIDER=s3`
> + the R2 credentials. The S3-compatible adapter is on the roadmap.

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
- **Push to main**: the **backend-contract gate** probes the live production
  backend's `GET /health` deployment identity (`deployment.commitSha`) and
  requires it to be a git ancestor of the release — a frontend release can
  never assume a backend contract that is not yet available
  (schema → backend → worker → frontend ordering). An architect-approved
  exceptional transition can skip the gate via `workflow_dispatch` with
  `skip_backend_gate=true` (recorded in the run log + evidence).
- Then: `vercel deploy --prod` + live production verification
  (`scripts/verify-cloud-deployment.sh`, `MODE=production`, `REQUIRE_READY=1`:
  SPA shell, assets, deep links, `/api` rewrite, backend liveness/readiness,
  authenticated read-only call through Browser → Vercel → Railway →
  PostgreSQL), the Railway backend stage (gated on `RAILWAY_TOKEN`; skips
  VISIBLY with manual steps when absent), and a per-release evidence record
  (job summary + artifact).

`deploy.yml` remains the validation CI for the frozen LOCAL docker-compose
topology — it never deploys to cloud providers and is not a second release
system.

Required repository configuration:

- secrets: `VERCEL_TOKEN`, `RAILWAY_TOKEN` (optional — enables automated
  backend deploys)
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
| `OBJECT_STORAGE_BUCKET` / `_ENDPOINT` / `_REGION` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | Railway (API + Worker) | S3-compatible object storage (e.g. Cloudflare R2) |
| `OBJECT_STORAGE_DIR` | Railway (API + Worker) | filesystem adapter directory (local/dev topology) |
| `WORKFLOWOS_ROLE` | Railway | `api` or `worker` (same image, two roles) |
| `PORT` | Railway (API) | provided by Railway; the image binds `0.0.0.0:$PORT` |
| `HOST` | Railway | `0.0.0.0` |
| `LOG_LEVEL` | Railway | `info` |
| `CORS_ORIGIN` | Railway (API) | the Vercel production origin |
| `WORKFLOWOS_GITHUB_WEBHOOK_SECRET` | Railway (API + Worker) | GitHub webhook secret |
| `API_TARGET` | Vercel (per environment) | production: the Railway API origin; preview: the isolation canary |

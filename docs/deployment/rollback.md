# Rollback Playbook — WorkflowOS Production Deployment

Deterministic rollback procedures for the production topology
(Vercel frontend + Railway backend + Neon PostgreSQL + object storage).
Produced by the deployment-hardening work; the Vercel procedure below has
been **exercised live against the production alias** (see
`evidence/2026-08-29-production-hardening.md`).

```text
bad frontend deployment  → Vercel: promote the previous deployment to the production alias
bad backend deployment   → Railway: redeploy the previous release of the api/worker services
schema migration         → compatibility verified BEFORE release; destructive changes are
                            explicitly staged (see "Database rollback reality" below)
```

## 1. Frontend (Vercel)

Vercel keeps every deployment; the production domain is an ALIAS pointing at
the current production deployment. Rolling back = re-pointing the alias at
the previous deployment. This is deterministic and takes effect within
seconds (~15–25s propagation observed).

### Via the API / CLI (recommended — scriptable)

```bash
VERCEL_TOKEN=<token>
TEAM=team_4KOoA5CgtYaOF85yFXPeMXLt
DOMAIN=frontend-gray-iota-23.vercel.app

# 1. List production deployments (newest first) and pick the previous GOOD one.
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v6/deployments?projectId=<project-id>&teamId=$TEAM&limit=5&target=production" \
  | python3 -c 'import json,sys; [print(d["uid"], d["state"], d["url"]) for d in json.load(sys.stdin)["deployments"]]'

# 2. Promote the chosen deployment to the production alias.
curl -s -X POST \
  "https://api.vercel.com/v2/deployments/<deployment-uid>/aliases?teamId=$TEAM" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"alias\":\"$DOMAIN\"}"

# 3. Verify the rollback.
curl -fsS "https://$DOMAIN/api/health"        # expect the healthy payload
```

CLI equivalent: `vercel promote <deployment-url> --token=<token>`.

### Live drill result (2026-08-29)

- Promoted the previous deployment → the alias switched within seconds and
  served that deployment's behavior (verified: its `/api` proxy failed with
  DNS_HOSTNAME_NOT_FOUND, exactly that deployment's defect).
- Promoted the current deployment back → the alias restored within ~15–25s
  and `/api/health` returned `{"status":"ok"}` again.
- Conclusion: promote/rollback is **deterministic and reversible**; both
  directions verified against the live production alias.

## 2. Backend (Railway)

Railway keeps every deployment of a service. Rolling back:

1. Railway dashboard → the **api** service → Deployments → the previous
   release → **Redeploy** (or via the CLI/API with a Railway token).
2. Repeat for the **worker** service (same image, different role — keep both
   on the SAME revision).
3. Verify:
   ```bash
   curl -fsS https://workflowos-production.up.railway.app/health
   # deployment.commitSha must equal the rollback target revision
   curl -fsS https://workflowos-production.up.railway.app/health/ready
   # postgres / redis / objectStore all ok
   ```

Keep the frontend within its contract: the backend rollback target must be
an ancestor of the deployed frontend's commit (the release pipeline's
backend-contract gate enforces this for NEW releases; a manual backend
rollback to a revision older than the frontend should be accompanied by a
matching frontend rollback — promote the Vercel deployment that matches the
backend revision).

## 3. Database rollback reality (do NOT over-claim)

Migrations in this repository are **transactional and forward-only**:

- each migration runs inside a transaction that also records it in
  `schema_migrations`, so application is exactly-once and retry-safe;
- migrations are NOT automatically reversible — `down` migrations do not
  exist.

Therefore:

- A failed migration leaves the schema at the last successful migration and
  the API process fails startup (visible in deploy logs) — state is never
  silently half-applied.
- Rolling back the APPLICATION does not roll back the SCHEMA. Releases are
  kept backward-compatible: a new backend release must run against the
  previous release's schema during the transition (additive migrations
  first; removal/renames only after the dependent release is retired).
- Destructive/irreversible migrations MUST be staged as follows:
  1. release N: additive migration (old + new code paths work);
  2. release N+1: code stops using the old surface;
  3. release N+2: the destructive migration, with a documented backup step.
- Neon provides point-in-time recovery as the last-resort data restore —
  it loses all writes after the restore point, so it is a disaster-recovery
  tool, not a release-rollback tool.

## 4. Redis and non-authoritative state

Redis is non-authoritative (queue/locks/cache). If Redis is restarted or
replaced, queued jobs may be lost — the transactional outbox (WORK-034)
re-enqueues pending obligations on the next worker boot, so the system
converges without manual action. No Redis rollback procedure exists or is
needed; correctness never depends on Redis durability.

## 5. Object storage

Objects are immutable, content-addressed artifacts (evidence, packages).
A rollback never deletes objects. If an external bucket is misconfigured,
fix the `OBJECT_STORAGE_*` variables and redeploy — note that an INCOMPLETE
`s3` configuration now fails startup (fail-closed) rather than silently
degrading durability.

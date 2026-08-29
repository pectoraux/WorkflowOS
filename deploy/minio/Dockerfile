# WorkflowOS production object storage — private-network, volume-backed
# MinIO (REQUEST CHANGES remediation, 2026-08-29).
#
# WHY THIS EXISTS: production object storage was configured with placeholder
# credentials and an invalid endpoint (a non-account-scoped
# *.r2.cloudflarestorage.com host that resolves only through wildcard DNS) —
# it never worked, and /health/ready stayed 503 forever. This service
# provides REAL, durable, S3-compatible object storage for the production
# topology, inside the Railway private network (no public exposure), behind
# the SAME ObjectStore boundary — the backend's dependency-free SigV4
# adapter speaks path-style requests, MinIO's native model.
#
# Deploy (from THIS directory — the service's code root is deploy/minio;
# the repository root carries no top-level Dockerfile, so a root-level
# upload to this service fails visibly by construction):
#
#   cd deploy/minio && railway up --service MinIO
#
# Storage: a Railway volume mounted at /data (attached to the service —
# see docs/deployment/production.md). Data is durable across redeploys.
# init.sh creates the production bucket idempotently on every boot.
#
# Service variables (secrets — NEVER commit them):
#   MINIO_ROOT_USER / MINIO_ROOT_PASSWORD  (also set as the backend services'
#   OBJECT_STORAGE_ACCESS_KEY_ID / OBJECT_STORAGE_SECRET_ACCESS_KEY)
#   MINIO_BUCKET=workflowos-prod
#
# Both base images are pinned to immutable upstream releases for
# reproducible builds (identical digests from identical sources).

FROM minio/mc:RELEASE.2025-04-16T18-13-26Z AS mc

FROM minio/minio:RELEASE.2025-04-22T22-12-26Z
COPY --from=mc /usr/bin/mc /usr/bin/mc
COPY init.sh /usr/local/bin/workflowos-minio-init
RUN chmod +x /usr/local/bin/workflowos-minio-init
ENTRYPOINT ["/usr/local/bin/workflowos-minio-init"]

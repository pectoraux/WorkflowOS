#!/bin/sh
# WorkflowOS production object storage — MinIO bootstrap (fail-closed).
#
# Starts the S3-compatible server on :9000 (Railway private network only —
# this service deliberately has NO public domain), then ensures the
# production bucket exists and stays private. MinIO does not auto-create
# buckets, and the backend's ObjectStore boundary deliberately carries no
# bucket-lifecycle responsibility — so the storage service owns it.
#
# Required service variables: MINIO_ROOT_USER, MINIO_ROOT_PASSWORD
# (see docs/deployment/production.md — Object storage).
#
# Idempotent: every boot re-asserts the bucket (`mc mb --ignore-existing`),
# so a volume that already carries data bootstraps unchanged.
set -eu

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
BUCKET="${MINIO_BUCKET:-workflowos-prod}"

minio server /data --address ":9000" --console-address ":9001" &
SERVER_PID=$!

# Forward the shutdown signal to the server so Railway redeploys drain
# gracefully instead of hard-killing MinIO mid-write.
trap 'kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; exit 0' TERM INT

# Wait for the local S3 API to answer (bounded — a broken server must
# surface in the deploy logs, not hang the boot).
i=0
until mc alias set wfos-local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 \
      && mc ls wfos-local >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "workflowos-minio: S3 API did not become ready within 30s — aborting" >&2
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

mc mb --ignore-existing "wfos-local/$BUCKET"
mc anonymous set none "wfos-local/$BUCKET" 2>/dev/null || true
echo "workflowos-minio: bucket '$BUCKET' ready (private, volume-backed)"

wait "$SERVER_PID"

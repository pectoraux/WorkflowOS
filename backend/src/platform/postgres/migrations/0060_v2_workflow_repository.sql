-- V2-002 — Workflow Repository + Immutable Versioning (WorkflowOS 2.0,
-- Work Order V2-002; constitution §14 repository/Git-like collaboration).
--
-- ADDITIVE ONLY: no existing table is altered. PostgreSQL remains the sole
-- authority for workflow repository/version/fork/install state (V2-002 work
-- order "Migration is additive and authority remains PostgreSQL").
--
-- Registry conformance (V2-CTRL-003): visibility identifiers are exactly the
-- canonical registry values (private | organization | public) — CHECK
-- constraints fail closed on any alias. The version digest rule is
-- SHA-256(canonical-json(semantic-object)) computed by the application layer
-- (V2-CTRL-003 "Canonical identity and digest rules"); repository metadata is
-- NOT part of the digest.
--
-- Tables (all namespaced wfos_v2_):
--   wfos_v2_workflows              durable Workflow identity (repository scope)
--   wfos_v2_workflow_versions      immutable, content-addressed WorkflowVersion
--   wfos_v2_workflow_collaborators explicit per-workflow permission grants
--   wfos_v2_workflow_installations tenant-scoped installs pinned to one version

-- ---------------------------------------------------------------------------
-- Workflow — durable repository identity (constitution §2: "durable identity,
-- repository/collaboration scope and public/private identity").
--
-- current_version_id deliberately has NO FK to wfos_v2_workflow_versions here
-- (circular table dependency); the FK is added after the versions table below.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_v2_workflows (
  workflow_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type             TEXT NOT NULL DEFAULT 'user' CHECK (owner_type = 'user'),
  owner_id               UUID NOT NULL REFERENCES wfos_users(id),
  tenant_id              UUID NOT NULL REFERENCES wfos_organizations(id),
  name                   TEXT NOT NULL,
  description            TEXT,
  visibility             TEXT NOT NULL
                           CHECK (visibility IN ('private', 'organization', 'public')),
  lifecycle_status       TEXT NOT NULL DEFAULT 'active'
                           CHECK (lifecycle_status IN ('active', 'archived')),
  current_version_id     TEXT,
  forked_from_workflow_id UUID REFERENCES wfos_v2_workflows(workflow_id),
  forked_from_version_id TEXT,
  protocol_version       TEXT NOT NULL DEFAULT '2.0' CHECK (protocol_version = '2.0'),
  created_by             UUID NOT NULL REFERENCES wfos_users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX wfos_v2_workflows_tenant_idx ON wfos_v2_workflows (tenant_id);
CREATE INDEX wfos_v2_workflows_owner_idx ON wfos_v2_workflows (owner_id);
CREATE INDEX wfos_v2_workflows_fork_source_idx ON wfos_v2_workflows (forked_from_workflow_id)
  WHERE forked_from_workflow_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- WorkflowVersion — immutable executable meaning. Content-addressed:
-- workflow_version_id is the deterministic id derived by the application from
-- the authoritative identity inputs (workflowId, contentDigest,
-- parentVersionId, protocolVersion). The same identity inputs converge on the
-- same row (duplicate delivery converges deterministically).
--
-- IMMUTABILITY IS ENFORCED BY THE DATABASE: a trigger rejects every UPDATE and
-- DELETE on this table (constitution §19 "silently alter immutable
-- WorkflowVersions" is forbidden; the negative proof is exercised by the
-- V2-002 battery via direct SQL mutation attempts). Rows are INSERT-only.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_v2_workflow_versions (
  workflow_version_id    TEXT PRIMARY KEY CHECK (workflow_version_id ~ '^wfv_[0-9a-f]{64}$'),
  workflow_id            UUID NOT NULL REFERENCES wfos_v2_workflows(workflow_id),
  content_digest         TEXT NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  content                JSONB NOT NULL,
  parent_version_id      TEXT REFERENCES wfos_v2_workflow_versions(workflow_version_id),
  protocol_version       TEXT NOT NULL DEFAULT '2.0' CHECK (protocol_version = '2.0'),
  provenance_origin      TEXT NOT NULL CHECK (provenance_origin IN ('authored', 'fork')),
  forked_from_workflow_id UUID REFERENCES wfos_v2_workflows(workflow_id),
  forked_from_version_id TEXT REFERENCES wfos_v2_workflow_versions(workflow_version_id),
  message                TEXT,
  commit_seq             BIGSERIAL NOT NULL,
  created_by             UUID NOT NULL REFERENCES wfos_users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (provenance_origin <> 'fork'
         OR (forked_from_workflow_id IS NOT NULL AND forked_from_version_id IS NOT NULL))
);

-- The workflow's current-version pointer is a real FK (added post-create to
-- break the circular dependency; every pointer targets an immutable version).
ALTER TABLE wfos_v2_workflows
  ADD CONSTRAINT wfos_v2_workflows_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES wfos_v2_workflow_versions(workflow_version_id);

CREATE INDEX wfos_v2_workflow_versions_workflow_idx
  ON wfos_v2_workflow_versions (workflow_id, commit_seq ASC);
CREATE UNIQUE INDEX wfos_v2_workflow_versions_digest_idx
  ON wfos_v2_workflow_versions (workflow_id, content_digest, parent_version_id);
CREATE INDEX wfos_v2_workflow_versions_parent_idx
  ON wfos_v2_workflow_versions (parent_version_id)
  WHERE parent_version_id IS NOT NULL;

-- Database-enforced immutability: versions are append-only. Every UPDATE or
-- DELETE is rejected (publisher changes create NEW versions; they never
-- mutate an installed version).
CREATE OR REPLACE FUNCTION wfos_v2_reject_workflow_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'wfos_v2_workflow_versions is immutable (V2-002): versions cannot be UPDATEd or DELETEd. Commit a new version instead.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wfos_v2_workflow_version_no_mutation ON wfos_v2_workflow_versions;
CREATE TRIGGER wfos_v2_workflow_version_no_mutation
  BEFORE UPDATE OR DELETE ON wfos_v2_workflow_versions
  FOR EACH ROW EXECUTE FUNCTION wfos_v2_reject_workflow_version_mutation();

-- ---------------------------------------------------------------------------
-- Collaborators — explicit per-workflow permission grants (repository
-- permissions remain explicit; private visibility grants nothing implicitly).
-- The owner of record is seeded here with role 'owner' at creation.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_v2_workflow_collaborators (
  workflow_id UUID NOT NULL REFERENCES wfos_v2_workflows(workflow_id),
  user_id     UUID NOT NULL REFERENCES wfos_users(id),
  role        TEXT NOT NULL CHECK (role IN ('owner', 'writer', 'reader')),
  granted_by  UUID REFERENCES wfos_users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workflow_id, user_id)
);

CREATE INDEX wfos_v2_workflow_collaborators_user_idx
  ON wfos_v2_workflow_collaborators (user_id);

-- ---------------------------------------------------------------------------
-- Installations — a tenant installing a workflow pins ONE immutable version.
-- Convergence: one installation per (workflow, tenant) — duplicate installs
-- converge on the same installation identity and NEVER silently re-pin
-- (re-pinning is an explicit customer-controlled PATCH).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_v2_workflow_installations (
  installation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id      UUID NOT NULL REFERENCES wfos_v2_workflows(workflow_id),
  tenant_id        UUID NOT NULL REFERENCES wfos_organizations(id),
  pinned_version_id TEXT NOT NULL REFERENCES wfos_v2_workflow_versions(workflow_version_id),
  status           TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  installed_by     UUID NOT NULL REFERENCES wfos_users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_id, tenant_id)
);

CREATE INDEX wfos_v2_workflow_installations_tenant_idx
  ON wfos_v2_workflow_installations (tenant_id);
CREATE INDEX wfos_v2_workflow_installations_version_idx
  ON wfos_v2_workflow_installations (pinned_version_id);

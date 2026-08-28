-- WORK-046 — Multi-Agent Delegation: the durable COORDINATION substrate.
--
-- The delegation layer is COORDINATION, NOT AUTHORITY (spec/work-orders/
-- WORK-046.md). These tables are coordination data referencing EXISTING
-- identities — they are NOT a second Work Item lifecycle, NOT execution
-- history authority (wfos_executions is), NOT role authority (the WORK-045
-- static catalog is), and NOT workflow state (wfos_workflow_executions is).
--
-- Identities:
--   plan  — ONE logical plan per (work_item_id, plan_key): the same
--           delegation request converges on ONE authoritative plan; two
--           concurrent creators serialize through the UNIQUE constraint.
--   unit  — ONE logical unit per (plan_id, unit_key): the stable delegation
--           identity (role assignment pinned at creation; stable across
--           retries).
--   attempt — ONE delegated EXECUTION per attempt: execution_id is UNIQUE
--           (an existing wfos_executions execution identity belongs to at
--           most ONE delegation attempt) and (unit_id, attempt_no) is
--           UNIQUE. A retry allocates a NEW attempt (a NEW execution
--           identity); the unit + role identity stay stable.
--
-- Statuses are COORDINATION vocabulary, structurally disjoint from the
-- frozen WorkflowState set (no hidden lifecycle state):
--   plan.status    active | completed | abandoned
--   unit.status    pending | dispatched | succeeded | failed | unresolved | cancelled
--   attempt.outcome NULL (in flight) | succeeded | failed | unresolved
--
-- NOTE ON NUMBERING: this migration is 0057 although main's last migration
-- is 0051 — 0052–0056 are reserved for the pending WORK-051 branch (PR #52).
-- Migrations apply in filename order; both merge orders stay clean.

CREATE TABLE wfos_delegation_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ONE plan belongs to exactly ONE existing Work Item (P1: ONE Work Item).
  work_item_id UUID NOT NULL REFERENCES wfos_work_items(id) ON DELETE CASCADE,
  -- The logical plan identity within the Work Item (the caller's stable key:
  -- 'default', a correction cycle key, ...). Same request ⇒ same plan.
  plan_key TEXT NOT NULL,
  -- COORDINATION status (NOT a Work Item lifecycle state — W046-AC09).
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'abandoned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ONE authoritative plan per (work item, plan key) — the durable
  -- idempotent identity (W046-AC01). Concurrent same-key creators converge
  -- here (INSERT ... ON CONFLICT DO NOTHING + row lock in the service).
  CONSTRAINT wfos_delegation_plans_key_uidx
    UNIQUE (work_item_id, plan_key)
);

CREATE TABLE wfos_delegation_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES wfos_delegation_plans(id) ON DELETE CASCADE,
  -- The stable LOGICAL unit identity within the plan (caller-provided key).
  unit_key TEXT NOT NULL,
  -- The WORK-045 role assignment, PINNED at plan creation (W045-AC10: a
  -- historical (identity, revision) reference can never be silently
  -- reinterpreted). roleId ∈ the closed catalog (service-validated, fail
  -- closed on unknown roles); roleRevision is the catalog content digest.
  role_id TEXT NOT NULL,
  role_revision TEXT NOT NULL,
  -- Heterogeneous execution: each unit names its mode + provider exactly as
  -- the existing execution route does (validated at the route against the
  -- existing registry; dispatched through the EXISTING ExecutionService).
  mode TEXT NOT NULL CHECK (mode IN ('native', 'external')),
  provider TEXT NOT NULL,
  model TEXT,
  -- The unit's dependencies (unit KEYS within the SAME plan) — coordination
  -- sequencing only; a unit dispatches when all dependencies succeeded.
  depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- COORDINATION status (NOT a Work Item lifecycle state — W046-AC09).
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispatched', 'succeeded', 'failed', 'unresolved', 'cancelled')),
  -- The number of attempts allocated so far (attempt N ⇒ rows in
  -- wfos_delegation_attempts with attempt_no 1..N).
  attempt_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ONE logical unit per (plan, unit key) — concurrent unit creation can
  -- never duplicate a logical unit (W046-AC01/AC02).
  CONSTRAINT wfos_delegation_units_key_uidx
    UNIQUE (plan_id, unit_key)
);

CREATE TABLE wfos_delegation_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id UUID NOT NULL REFERENCES wfos_delegation_units(id) ON DELETE CASCADE,
  -- The attempt number within the unit (1, 2, 3... — retries allocate the
  -- next one; the unit + role identity stay stable).
  attempt_no INT NOT NULL CHECK (attempt_no > 0),
  -- The EXISTING execution identity (wfos_executions.execution_id). The
  -- attempt row is the DURABLE INTENT written BEFORE
  -- ExecutionService.submit() — the crash-safety anchor: a re-drive finds
  -- the attempt and converges (observe-or-resubmit) instead of allocating a
  -- second execution for the same logical attempt.
  execution_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('native', 'external')),
  provider TEXT NOT NULL,
  model TEXT,
  -- COORDINATION outcome (NOT a lifecycle state):
  --   NULL        — dispatched / in flight (the existing execution flow owns
  --                 the outcome; observe converges it when terminal)
  --   succeeded   — the existing execution record reached a successful
  --                 terminal state (completed)
  --   failed      — the existing execution record reached a failed terminal
  --                 state (failed | cancelled | expired)
  --   unresolved  — the attempt's outcome could not be determined AND no
  --                 provider side effect provably happened (safe to retry)
  outcome TEXT
    CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'unresolved')),
  -- Structured observation detail for WORK-047 (status observed, agentRunId,
  -- external session ref, package presence, timestamps).
  outcome_detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ONE attempt per (unit, attempt_no) — the attempt allocation CAS.
  CONSTRAINT wfos_delegation_attempts_no_uidx
    UNIQUE (unit_id, attempt_no),
  -- ONE execution identity per delegated EXECUTION (P3): an existing
  -- execution belongs to at most ONE delegation attempt — structurally.
  CONSTRAINT wfos_delegation_attempts_execution_uidx
    UNIQUE (execution_id)
);

CREATE INDEX wfos_delegation_plans_wi_idx ON wfos_delegation_plans (work_item_id);
CREATE INDEX wfos_delegation_units_plan_idx ON wfos_delegation_units (plan_id);
CREATE INDEX wfos_delegation_attempts_unit_idx ON wfos_delegation_attempts (unit_id);

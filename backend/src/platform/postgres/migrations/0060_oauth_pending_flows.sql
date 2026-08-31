-- WORK-074 (OAuth browser-binding hardening) — the server-side pending OAuth
-- flow record.
--
-- WORK-063's OAuth/OIDC flow (Google, GitHub) uses an authorization-code
-- redirect with a `state` parameter for CSRF protection. The original WORK-074
-- runtime stored `state` only in a short-lived browser cookie and checked
-- `query.state === cookie.state` on the callback. That proves only "the
-- browser that started the flow receives the callback" — it does NOT prove a
-- durable correlation to a distinct login transaction, and it offers NO
-- one-time-use (replay) protection.
--
-- This migration adds the server-side pending-flow record that closes the
-- cross-browser / replay gap:
--
--   1. /auth/login/:provider generates `state` (random) AND a browser-binding
--      secret (random). It stores ONLY the SHA-256 digest of the
--      browser-binding secret here (SEC-AC-02 — the raw secret lives ONLY in
--      the httpOnly `wfos_oauth_flow` cookie). It inserts a pending-flow row
--      keyed by `state` with `browser_binding` = digest + `expires_at`.
--   2. /auth/callback/:provider reads the `wfos_oauth_flow` cookie, computes
--      its digest, looks up the pending flow by `state`, and verifies:
--        - the flow exists (rejects an unknown state)
--        - the flow is not expired (rejects a stale flow)
--        - the flow's `browser_binding` matches the cookie's digest (rejects
--          a cross-browser presentation: Browser B does not have Browser A's
--          `wfos_oauth_flow` cookie)
--        - the flow is not yet consumed (rejects a replay — the atomic
--          UPDATE consumed_at = NOW() WHERE consumed_at IS NULL ensures
--          exactly one consumer wins, even under concurrency)
--   3. The winner exchanges the code, resolves the identity, creates the
--      session. The flow row remains (consumed_at set) as a durable record
--      of the completed transaction; a later replay of the same callback is
--      rejected because consumed_at is already set.
--
-- PostgreSQL is authoritative for the pending-flow state (WORK-063 invariant
-- #14). The raw browser-binding secret is NEVER stored (SEC-AC-02) — only its
-- SHA-256 digest.

CREATE TABLE wfos_oauth_pending_flows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The OAuth `state` parameter (sent to the provider, returned in the
  -- callback). UNIQUE so a callback resolves at most one pending flow.
  state           TEXT NOT NULL UNIQUE,
  -- 'google' | 'github'. Recorded so a callback for provider X cannot
  -- consume a flow started for provider Y (defense in depth).
  provider        TEXT NOT NULL,
  -- SHA-256 hex digest of the browser-binding secret (the raw secret lives
  -- only in the httpOnly wfos_oauth_flow cookie). This binds the pending
  -- flow to the browser that started it (cross-browser rejection).
  browser_binding TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The flow expires (default 10 minutes — matches the cookie max-age).
  expires_at      TIMESTAMPTZ NOT NULL,
  -- NULL until the callback consumes the flow. Once set, the flow is
  -- one-time-use: a replay of the same callback is rejected (the atomic
  -- UPDATE consumed_at = NOW() WHERE consumed_at IS NULL ensures exactly
  -- one consumer wins, even under a concurrent replay).
  consumed_at     TIMESTAMPTZ
);

CREATE INDEX wfos_oauth_pending_flows_state_idx ON wfos_oauth_pending_flows (state);
CREATE INDEX wfos_oauth_pending_flows_expires_idx ON wfos_oauth_pending_flows (expires_at);

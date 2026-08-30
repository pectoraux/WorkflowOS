-- WORK-074 — Identity & Access runtime activation (the runtime of WORK-063's spec).
--
-- This migration implements the RUNTIME persistence layer the WORK-063
-- architecture decision specified. It adds:
--   - wfos_user_identities  (provider → subject → user linking; AUTH-AC-01
--                            generalized from the API-key precedent to OIDC
--                            subjects and email subjects).
--   - wfos_user_passwords   (email/password credentials — DIGEST ONLY; the
--                            raw password is NEVER persisted, SEC-AC-02).
--   - wfos_sessions         (server-side, authoritative, revocable sessions —
--                            the human login session lifecycle).
--   - wfos_service_accounts (machine principals — first-class, NOT users;
--                            belong to an organization, hold an explicit
--                            capability set).
--   - wfos_capabilities + wfos_capability_permissions (the capability →
--                            permission mapping that lets machine principals
--                            flow through the SAME AuthorizationService path).
--   - EXTENDS wfos_api_key_credentials with service_account_id + scopes
--                            (scoped API credentials — API keys REMAIN
--                            first-class; this is an EXTENSION, never a
--                            removal, per WORK-063 invariant #10).
--
-- Security discipline (SEC-AC-01/02, unchanged):
--   - Raw password material is NEVER stored. wfos_user_passwords holds a
--     salted scrypt-derived DIGEST (password_hash), never the raw password.
--   - Raw session tokens are NEVER stored. wfos_sessions holds a DIGEST of
--     the opaque session token (token_digest), never the raw token. The raw
--     token is presented by the cookie and matched by digest.
--   - Raw API-key material is NEVER stored (unchanged from migration 0003).
--   - No OAuth/OIDC provider token (access/refresh/id token) is persisted
--     here. Provider tokens are used ephemerally during the callback to
--     resolve the OIDC subject, then discarded.
--
-- PostgreSQL remains authoritative for identity, membership, session, and
-- authorization state (architecture §28, WORK-063 invariant #14). External
-- identity providers are authoritative ONLY for their authentication assertion.
--
-- This migration does NOT introduce a second authorization engine: the
-- capability → permission mapping feeds the EXISTING AuthorizationService
-- (src/modules/auth/internal/authorization-service.ts) for machine principals,
-- the same way role → permission feeds it for human principals. One chain.

-- ---------------------------------------------------------------------------
-- Linked provider identities (AUTH-AC-01 generalized to OIDC subjects).
--
-- A human signs in via Google/GitHub/email; the provider + subject pair
-- resolves deterministically to exactly one WorkflowOS user. Multiple
-- provider identities may link to one user (identity linking).
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_user_identities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES wfos_users(id) ON DELETE CASCADE,
  -- 'google' | 'github' | 'email'. A new provider is a new adapter, never a
  -- new authority (WORK-063).
  provider    TEXT NOT NULL,
  -- The stable subject: OIDC `sub` for google/github; the lowercased email
  -- for the email provider. Used for deterministic identity resolution.
  subject     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, subject)
);

CREATE INDEX wfos_user_identities_user_idx ON wfos_user_identities (user_id);

-- ---------------------------------------------------------------------------
-- Email/password credentials (DIGEST ONLY — SEC-AC-02).
--
-- The raw password is NEVER stored. `password_hash` is a salted scrypt-derived
-- digest. A database leak does NOT expose usable credentials.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_user_passwords (
  user_id        UUID PRIMARY KEY REFERENCES wfos_users(id) ON DELETE CASCADE,
  password_hash  TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Server-side sessions (WORK-063 invariant #5 — server-side, authoritative,
-- revocable; no immortal tokens).
--
-- The raw session token is NEVER stored; `token_digest` is a SHA-256 digest
-- of the opaque token presented by the cookie. A session is matched by digest,
-- checked for expiry, and checked for revocation. Logout/revocation sets
-- `revoked_at`; a revoked session is rejected on the next request.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES wfos_users(id) ON DELETE CASCADE,
  -- SHA-256 digest of the opaque session token. The raw token lives ONLY in
  -- the httpOnly cookie; it is never persisted (SEC-AC-02).
  token_digest    TEXT NOT NULL UNIQUE,
  -- 'human' for browser login sessions; 'machine' for service-account
  -- sessions (a machine principal may hold a session the same way a human
  -- does, but the principal kind is recorded so human/machine never confuse).
  principal_kind  TEXT NOT NULL DEFAULT 'human',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ,
  user_agent      TEXT,
  ip_address      TEXT
);

CREATE INDEX wfos_sessions_user_idx ON wfos_sessions (user_id);
CREATE INDEX wfos_sessions_token_digest_idx ON wfos_sessions (token_digest);

-- ---------------------------------------------------------------------------
-- Service accounts (machine principals — WORK-063 invariant #3).
--
-- A service account is a FIRST-CLASS PRINCIPAL, NOT a user. It belongs to an
-- organization and holds an explicit capability set. It NEVER impersonates a
-- human. Authorization decisions for a machine principal flow through the SAME
-- AuthorizationService (capability → permission mapping), never a parallel
-- mechanism.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_service_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- Explicit capability set. A capability not granted is denied (fail closed,
  -- WORK-063 invariant #6).
  capabilities    TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The human who created the service account (audit provenance). May be NULL
  -- for seeded service accounts.
  created_by      UUID REFERENCES wfos_users(id)
);

CREATE INDEX wfos_service_accounts_org_idx ON wfos_service_accounts (organization_id);
CREATE UNIQUE INDEX wfos_service_accounts_org_name_idx
  ON wfos_service_accounts (organization_id, name);

-- ---------------------------------------------------------------------------
-- Machine capabilities (the vocabulary for service-account capability sets).
--
-- Distinct from human permissions (wfos_permissions): a capability is a
-- machine-actionable grant; a permission is the authorization primitive the
-- AuthorizationService resolves for a resource. The capability → permission
-- mapping (below) bridges the two so machine principals flow through the SAME
-- AuthorizationService path.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_capabilities (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

INSERT INTO wfos_capabilities (id, name) VALUES
  ('workitem.read',         'Read Work Items'),
  ('workitem.write',        'Create/Update Work Items'),
  ('branch.create',         'Create branches'),
  ('pr.create',              'Create pull requests'),
  ('execution.read',        'Read execution state'),
  ('architecture.modify',   'Modify architecture'),
  ('governance.approve',    'Approve governance (PRs/reviews)'),
  ('verification.alter',    'Alter verification evidence'),
  ('tenant.change',         'Change tenant ownership')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Capability → permission mapping.
--
-- The SAME AuthorizationService resolves permissions for a resource. For a
-- machine principal, the granted capabilities are mapped to permissions here,
-- then the existing membership + project-access checks apply. There is ONE
-- authorization chain; this mapping is how machine principals ENTER it.
--
-- The privileged capabilities (architecture.modify, governance.approve,
-- verification.alter, tenant.change) map to permissions that the
-- implementation-agent capability set NEVER holds (privilege separation,
-- WORK-063 invariant #7). They are defined here so a credential WITH the
-- capability can exercise them — but the implementation-agent credential
-- set does NOT include them.
-- ---------------------------------------------------------------------------
CREATE TABLE wfos_capability_permissions (
  capability_id  TEXT NOT NULL REFERENCES wfos_capabilities(id),
  permission_id  TEXT NOT NULL REFERENCES wfos_permissions(id),
  PRIMARY KEY (capability_id, permission_id)
);

INSERT INTO wfos_capability_permissions (capability_id, permission_id) VALUES
  ('workitem.read',         'project.read'),
  ('workitem.write',        'project.write'),
  ('branch.create',         'project.write'),
  ('pr.create',             'project.write'),
  ('execution.read',        'project.read'),
  ('architecture.modify',   'project.admin'),
  ('governance.approve',    'org.admin'),
  ('verification.alter',    'project.admin'),
  ('tenant.change',         'org.admin')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Extend API-key credentials: scope to a service account + explicit scopes.
--
-- API keys REMAIN first-class (WORK-063 invariant #10). This is an EXTENSION:
--   - service_account_id (nullable): when set, the key authenticates a
--     machine principal (the service account), and authorization uses the
--     capability → permission mapping.
--   - scopes (TEXT[], default '{}'): the explicit capabilities granted to THIS
--     credential. A credential's effective capability set is the
--     intersection of the service account's capabilities and the credential's
--     scopes (fail closed: a capability not in BOTH is denied).
--
-- Existing rows (the demo key) get service_account_id=NULL and scopes='{}' —
-- they continue to authenticate a human external_id (the demo-user) exactly as
-- before. The demo key is removed from the CUSTOMER-FACING LOGIN PATH only
-- (the frontend LoginPage); the API-key mechanism stays for automation.
-- ---------------------------------------------------------------------------
ALTER TABLE wfos_api_key_credentials
  ADD COLUMN service_account_id UUID REFERENCES wfos_service_accounts(id) ON DELETE CASCADE,
  ADD COLUMN scopes TEXT[] NOT NULL DEFAULT '{}';

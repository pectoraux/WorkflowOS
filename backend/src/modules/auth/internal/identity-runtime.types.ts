import type { User } from '@modules/users/index.js';
import type { Organization } from '@modules/organizations/index.js';

/**
 * WORK-074 runtime identity types — sessions, service accounts, principals.
 *
 * These extend the WORK-002 / WORK-063 auth contracts. They live behind the
 * /auth public boundary (src/modules/auth/index.ts); the AuthorizationService,
 * AuthProvider, ApiKeyAuthProvider contracts in auth.types.ts are unchanged in
 * spirit — the runtime ADDS adapters and the session/service-account layer
 * behind the SAME boundary.
 *
 * SECURITY: raw session tokens, raw passwords, and OAuth provider tokens are
 * NEVER persisted (SEC-AC-02). Only digests and opaque references are stored.
 */

// ---------------------------------------------------------------------------
// Principal — the resolved result of authentication (human OR machine).
//
// Authentication produces a principal; identity resolution then maps the
// principal to a persisted WorkflowOS user (human) or service account
// (machine). The two are DISTINCT and never confused (WORK-063 invariant #3):
// a machine principal is NEVER a human user, and a human principal is NEVER a
// service account.
// ---------------------------------------------------------------------------

export interface HumanPrincipal {
  readonly kind: 'human';
  readonly user: User;
  /** The provider that authenticated this human ('google'|'github'|'email'). */
  readonly provider: string;
}

export interface MachinePrincipal {
  readonly kind: 'machine';
  readonly serviceAccount: ServiceAccount;
  /** The provider that authenticated this machine ('apikey'). */
  readonly provider: string;
  /**
   * The effective capability set for THIS credential — the intersection of
   * the service account's capabilities and the credential's scopes
   * (fail closed: a capability not in BOTH is denied).
   */
  readonly capabilities: readonly string[];
}

export type Principal = HumanPrincipal | MachinePrincipal;

// ---------------------------------------------------------------------------
// Session — server-side, authoritative, revocable (WORK-063 invariant #5).
// ---------------------------------------------------------------------------

export type PrincipalKind = 'human' | 'machine';

export interface Session {
  readonly id: string;
  readonly userId: string;
  /** SHA-256 digest of the opaque session token (the raw token is NEVER stored). */
  readonly tokenDigest: string;
  readonly principalKind: PrincipalKind;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

/** The raw opaque session token (returned to the cookie, never persisted). */
export type SessionToken = string;

export interface CreateSessionInput {
  userId: string;
  principalKind: PrincipalKind;
  /** Session lifetime in seconds (default 7 days). */
  ttlSeconds?: number;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface VerifiedSession {
  readonly session: Session;
  /** Whether the session is currently valid (not expired, not revoked). */
  readonly valid: boolean;
  readonly invalidReason?: 'expired' | 'revoked' | 'not-found';
}

/**
 * Server-side session lifecycle (WORK-063 invariant #5).
 *
 * The session token is a high-entropy opaque string. Only its SHA-256 digest
 * is persisted (`wfos_sessions.token_digest`). Verification looks up the
 * session by digest, then checks expiry AND revocation. Logout/revocation
 * sets `revoked_at`; a revoked session is rejected on the next request.
 */
export interface SessionService {
  /** Create a new session; return the raw opaque token (to set in the cookie). */
  create(input: CreateSessionInput): Promise<{ token: SessionToken; session: Session }>;
  /**
   * Verify a presented raw token. Returns `{ valid: false }` for an unknown,
   * expired, or revoked session. Updates `last_used_at` on a valid session.
   */
  verify(token: SessionToken): Promise<VerifiedSession>;
  /** Revoke a session by its raw token (logout). Idempotent. */
  revoke(token: SessionToken): Promise<void>;
  /** Revoke ALL sessions for a user (e.g. on credential compromise). */
  revokeAllForUser(userId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Service account — a first-class machine principal (WORK-063 invariant #3).
// ---------------------------------------------------------------------------

export interface ServiceAccount {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  /** Explicit capability set. A capability not granted is denied (fail closed). */
  readonly capabilities: readonly string[];
  readonly createdAt: Date;
  readonly createdBy: string | null;
}

export interface CreateServiceAccountInput {
  organizationId: string;
  name: string;
  capabilities: readonly string[];
  createdBy?: string | null;
}

export interface ServiceAccountRepository {
  create(input: CreateServiceAccountInput): Promise<ServiceAccount>;
  findById(id: string): Promise<ServiceAccount | null>;
  listForOrganization(organizationId: string): Promise<ServiceAccount[]>;
  /** Add/remove capabilities (capability set is explicit + audited). */
  setCapabilities(id: string, capabilities: readonly string[]): Promise<ServiceAccount | null>;
  delete(id: string): Promise<void>;
}

/**
 * Capability → permission resolution. The SAME AuthorizationService resolves
 * permissions for a resource; for a machine principal, the granted capabilities
 * are mapped to permissions here. There is ONE authorization chain.
 */
export interface CapabilityPermissionRepository {
  /** List the permission ids granted by ANY of the given capabilities. */
  listPermissionsForCapabilities(capabilities: readonly string[]): Promise<string[]>;
  /** List ALL capability ids (the vocabulary). */
  listAllCapabilities(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// OAuth/OIDC provider — a new adapter behind the existing AuthProvider
// boundary (WORK-063: a new provider is a new adapter, never a new authority).
//
// The OAuth flow is multi-step (redirect → callback → code exchange), so it
// does not fit the single-credential `AuthProvider.authenticate(raw)` shape.
// The OAuthProvider interface is a SEPARATE adapter shape; both produce an
// AuthenticationResult through the SAME /auth boundary.
// ---------------------------------------------------------------------------

/** A resolved external identity from a provider (Google/GitHub/email). */
export interface ExternalIdentity {
  readonly provider: string;
  /** Stable subject (OIDC `sub` for google/github; lowercased email for email). */
  readonly subject: string;
  /** Display name (best-effort, from provider userinfo or email). */
  readonly displayName: string;
  /** Email if the provider asserts one (Google/GitHub/email). */
  readonly email: string | null;
}

export interface OAuthProvider {
  readonly name: string;
  /** Build the provider authorization URL (redirect the browser here). */
  getAuthorizationUrl(state: string, redirectUri: string): string;
  /**
   * Exchange the callback code for the resolved external identity. Uses the
   * provider's token endpoint + userinfo endpoint. Provider client secrets
   * are read from the SecretStore (env) — NEVER from the frontend.
   */
  exchangeCode(code: string, state: string, redirectUri: string): Promise<ExternalIdentity | null>;
}

/**
 * Injectable HTTP client for OAuth token exchange + userinfo. Production uses
 * `fetch`; tests inject a controlled client that returns real-shaped OIDC
 * responses (proving the OAuth code path against real provider semantics).
 */
export interface OAuthHttpClient {
  postForm(url: string, params: Record<string, string>): Promise<{ status: number; json: () => Promise<unknown> }>;
  getJson(url: string, bearerToken: string): Promise<{ status: number; json: () => Promise<unknown> }>;
}

// ---------------------------------------------------------------------------
// Identity linking (WORK-063 proof #3 — multiple provider identities resolve
// to one user).
// ---------------------------------------------------------------------------

export interface UserIdentity {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly subject: string;
  readonly createdAt: Date;
}

export interface UserIdentityRepository {
  /** Find a linked identity by (provider, subject). */
  findByProviderAndSubject(provider: string, subject: string): Promise<UserIdentity | null>;
  /** Link a provider identity to a user (idempotent on provider+subject). */
  link(userId: string, provider: string, subject: string): Promise<UserIdentity>;
  /** List all linked identities for a user. */
  listForUser(userId: string): Promise<UserIdentity[]>;
}

// ---------------------------------------------------------------------------
// Email/password credentials repository (DIGEST ONLY — SEC-AC-02).
// ---------------------------------------------------------------------------

export interface UserPasswordRepository {
  /** Store a password digest for a user (upsert). Raw password NEVER stored. */
  setForUser(userId: string, passwordHash: string): Promise<void>;
  /** Retrieve the stored digest for verification (returns null if none). */
  getForUser(userId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Organization context (used by the auth runtime for the self-hosting flow).
// Re-exported here so the auth route can compose organization creation +
// membership assignment through the existing /organizations authority.
// ---------------------------------------------------------------------------

export type { Organization };

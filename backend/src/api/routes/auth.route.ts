import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AuthorizationService,
  SessionService,
  ServiceAccountRepository,
  OAuthProvider,
  EmailAuthProvider,
  IdentityResolver,
  ApiKeyCredentialProvisioner,
  OAuthPendingFlowRepository,
} from '@modules/auth/index.js';
import type { AuditEventWriter } from '@modules/audit/index.js';
import type { UserRepository } from '@modules/users/index.js';
import type { OrganizationRepository, MembershipRepository } from '@modules/organizations/index.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { SESSION_COOKIE_NAME } from '../plugins/auth.plugin.js';
import { createHash, randomBytes } from 'node:crypto';

/**
 * The OAuth browser-binding cookie name. A high-entropy secret set on
 * /auth/login/:provider and verified (by digest, server-side) on
 * /auth/callback/:provider. Distinct from the OAuth `state` parameter: the
 * state is sent to the provider (visible in the URL); the browser-binding
 * secret stays in the httpOnly cookie (never sent to the provider). The
 * callback binds the two: the pending flow is recorded server-side with the
 * digest of the browser-binding secret, so only the browser that started the
 * flow can consume it (cross-browser rejection), and the flow is one-time-use
 * (replay rejection).
 */
const OAUTH_FLOW_COOKIE_NAME = 'wfos_oauth_flow';
/** The OAuth pending-flow lifetime (matches the cookie max-age). */
const OAUTH_FLOW_TTL_SECONDS = 10 * 60;

/**
 * Generate a high-entropy OAuth `state` parameter (CSRF). The state is sent
 * to the provider (visible in the redirect URL) and recorded server-side.
 */
function generateOAuthState(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Generate a high-entropy browser-binding secret. This value lives ONLY in
 * the httpOnly `wfos_oauth_flow` cookie — it is NEVER sent to the provider,
 * NEVER persisted (only its SHA-256 digest is stored server-side, SEC-AC-02).
 * It binds the pending OAuth flow to the browser that started it.
 */
function generateBrowserBindingSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest of the browser-binding secret (the server stores only this). */
function browserBindingDigest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * WORK-074 — authentication routes (the runtime of WORK-063's spec).
 *
 * The human login surface:
 *   - POST /auth/signup/email          — email/password signup → session cookie
 *   - POST /auth/login/email           — email/password login → session cookie
 *   - GET  /auth/login/google           — redirect to Google OAuth
 *   - GET  /auth/callback/google        — Google OAuth callback → session cookie
 *   - GET  /auth/login/github           — redirect to GitHub OAuth
 *   - GET  /auth/callback/github        — GitHub OAuth callback → session cookie
 *   - POST /auth/logout                 — revoke session, clear cookie
 *   - GET  /auth/me                     — current principal (401 if unauthenticated)
 *
 * The machine-identity surface (service accounts + scoped API credentials):
 *   - POST /auth/service-accounts                          — create (human, org admin)
 *   - GET  /auth/service-accounts?organizationId=...        — list (human, member)
 *   - POST /auth/service-accounts/:id/credentials          — provision scoped API key
 *
 * SECURITY: the session cookie is httpOnly + SameSite=Lax (so the OAuth
 * callback redirect sets it) + Secure in production (when CORS_ORIGIN is
 * https). The raw session token and raw API key are NEVER returned in a body
 * except the ONE-TIME credential-issuance response (the raw API key is shown
 * once at provisioning, then only the digest is stored — SEC-AC-02).
 */

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_COOKIE_PATH = '/';

export interface AuthRouteDeps {
  sessionService: SessionService;
  emailProvider: EmailAuthProvider;
  identityResolver: IdentityResolver;
  userRepository: UserRepository;
  organizationRepository: OrganizationRepository;
  membershipRepository: MembershipRepository;
  serviceAccountRepository: ServiceAccountRepository;
  apiKeyProvisioner: ApiKeyCredentialProvisioner;
  apiKeySecretStoreRef: (keyId: string) => string;
  /** SecretStore key holding the value to compare against the presented secret. */
  secretsEnv: { getSecret(key: string): Promise<string | null> };
  /**
   * OAuth providers, keyed by name. Present when the operator configured the
   * corresponding env vars (GOOGLE_OAUTH_CLIENT_ID, etc.). When absent, the
   * provider's login/callback routes return 503 (service unavailable) — the
   * email path remains the customer-facing default.
   */
  oauthProviders?: Record<string, OAuthProvider>;
  /** The public base URL for callback redirects (e.g. https://app.example.com). */
  publicBaseUrl?: string;
  /** Whether to set the Secure flag on cookies (true in HTTPS production). */
  cookieSecure?: boolean;
  authorizationService: AuthorizationService;
  /**
   * WORK-074 (OAuth browser-binding hardening): the server-side pending OAuth
   * flow repository. Required when `oauthProviders` is present (the OAuth
   * login/callback routes use it to bind the callback to the distinct login
   * transaction + provide one-time-use replay protection).
   */
  oauthPendingFlows?: OAuthPendingFlowRepository;
  /**
   * WORK-074 audit coverage (invariant #12). When present, login/logout,
   * credential issuance, and service-account creation events are recorded on
   * the /audit surface. The writer is the existing application boundary;
   * no second audit authority is introduced.
   */
  auditWriter?: AuditEventWriter;
}

export async function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  // -------------------------------------------------------------------------
  // Email/password signup + login.
  // -------------------------------------------------------------------------

  app.post('/auth/signup/email', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as EmailSignupBody;
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
      await reply.code(400).send({ error: 'invalid-request' });
      return;
    }
    try {
      const { user } = await deps.emailProvider.signup({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
      });
      const { token } = await deps.sessionService.create({
        userId: user.id,
        principalKind: 'human',
        ttlSeconds: SESSION_TTL_SECONDS,
        userAgent: req.headers['user-agent'] ?? null,
        ipAddress: req.ip,
      });
      setSessionCookie(reply, token, deps.cookieSecure);
      await recordAuthEvent(deps, 'auth.signup', user.id, 'user', user.id, {
        provider: 'email', email: user.email,
      });
      await reply.code(201).send({ user: publicUser(user) });
    } catch (err) {
      if (err instanceof Error && err.name === 'EmailAuthError') {
        const code = (err as unknown as { code: string }).code;
        await reply.code(409).send({ error: code });
        return;
      }
      throw err;
    }
  });

  app.post('/auth/login/email', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as EmailLoginBody;
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
      await reply.code(400).send({ error: 'invalid-request' });
      return;
    }
    const user = await deps.emailProvider.verify(body.email, body.password);
    if (!user) {
      // Never reveal whether the email exists (user-enumeration defense).
      await reply.code(401).send({ error: 'invalid-credentials' });
      return;
    }
    const { token } = await deps.sessionService.create({
      userId: user.id,
      principalKind: 'human',
      ttlSeconds: SESSION_TTL_SECONDS,
      userAgent: req.headers['user-agent'] ?? null,
      ipAddress: req.ip,
    });
    setSessionCookie(reply, token, deps.cookieSecure);
    await recordAuthEvent(deps, 'auth.login', user.id, 'user', user.id, {
      provider: 'email', email: user.email,
    });
    await reply.code(200).send({ user: publicUser(user) });
  });

  // -------------------------------------------------------------------------
  // OAuth/OIDC login (Google, GitHub).
  // -------------------------------------------------------------------------

  app.get('/auth/login/:provider', async (req: FastifyRequest, reply: FastifyReply) => {
    const { provider } = req.params as { provider: string };
    const oauth = deps.oauthProviders?.[provider];
    if (!oauth) {
      await reply.code(503).send({ error: 'provider-not-configured', provider });
      return;
    }
    if (!deps.oauthPendingFlows) {
      // The runtime was wired with OAuth providers but without the pending-flow
      // repository — a configuration error. Fail closed (do NOT start a flow
      // that cannot be safely completed).
      await reply.code(503).send({ error: 'oauth-pending-flow-store-not-configured' });
      return;
    }
    // Generate the OAuth `state` (CSRF — visible in the redirect URL) AND a
    // browser-binding secret (NEVER sent to the provider; lives only in the
    // httpOnly wfos_oauth_flow cookie). The two together bind the pending
    // flow to the browser that started it.
    const state = generateOAuthState();
    const browserBindingSecret = generateBrowserBindingSecret();
    const browserBinding = browserBindingDigest(browserBindingSecret);
    // Record the pending flow server-side (PostgreSQL authoritative). Only the
    // digest is stored — the raw secret is in the cookie (SEC-AC-02).
    await deps.oauthPendingFlows.create({
      state,
      provider,
      browserBinding,
      ttlSeconds: OAUTH_FLOW_TTL_SECONDS,
    });
    // Set the browser-binding cookie (httpOnly, short-lived). SameSite=Lax so
    // the OAuth callback redirect (a top-level navigation from the provider)
    // carries it back to the callback.
    reply.header(
      'Set-Cookie',
      cookieHeader(OAUTH_FLOW_COOKIE_NAME, browserBindingSecret, {
        httpOnly: true,
        sameSite: 'lax',
        secure: deps.cookieSecure ?? false,
        path: SESSION_COOKIE_PATH,
        maxAge: OAUTH_FLOW_TTL_SECONDS,
      }),
    );
    const redirectUri = callbackUrl(deps.publicBaseUrl, provider);
    const url = oauth.getAuthorizationUrl(state, redirectUri);
    await reply.redirect(302, url);
  });

  app.get('/auth/callback/:provider', async (req: FastifyRequest, reply: FastifyReply) => {
    const { provider } = req.params as { provider: string };
    const query = req.query as { code?: string; state?: string };
    const oauth = deps.oauthProviders?.[provider];
    if (!oauth) {
      await reply.code(503).send({ error: 'provider-not-configured', provider });
      return;
    }
    if (!deps.oauthPendingFlows) {
      await reply.code(503).send({ error: 'oauth-pending-flow-store-not-configured' });
      return;
    }
    if (!query.code || !query.state) {
      await reply.code(400).send({ error: 'invalid-callback', reason: 'missing-code-or-state' });
      return;
    }
    // Read the browser-binding secret from the cookie. Browser B (which did
    // NOT start this flow) has a different or no wfos_oauth_flow cookie → its
    // digest will not match the pending flow's browser_binding → rejected.
    const browserBindingSecret = readCookie(req, OAUTH_FLOW_COOKIE_NAME);
    if (!browserBindingSecret) {
      await reply.code(400).send({ error: 'invalid-callback', reason: 'missing-browser-binding' });
      return;
    }
    const browserBinding = browserBindingDigest(browserBindingSecret);

    // Atomically consume the pending flow. The atomic UPDATE (WHERE
    // consumed_at IS NULL) ensures exactly one consumer wins under a
    // concurrent replay; the browser-binding digest in the WHERE clause
    // rejects a cross-browser presentation BEFORE the consume.
    const consumeResult = await deps.oauthPendingFlows.consume({
      state: query.state,
      provider,
      browserBinding,
    });
    if (consumeResult.kind !== 'consumed') {
      // Typed denials: unknown / expired / browser-mismatch / replay.
      await reply.code(400).send({
        error: 'invalid-callback',
        reason: consumeResult.kind,
        detail: consumeResult.reason,
      });
      return;
    }
    // Clear the browser-binding cookie (one-time use — the flow is consumed).
    reply.header(
      'Set-Cookie',
      cookieHeader(OAUTH_FLOW_COOKIE_NAME, '', {
        httpOnly: true,
        sameSite: 'lax',
        secure: deps.cookieSecure ?? false,
        path: SESSION_COOKIE_PATH,
        maxAge: 0,
      }),
    );
    const redirectUri = callbackUrl(deps.publicBaseUrl, provider);
    const identity = await oauth.exchangeCode(query.code, query.state, redirectUri);
    if (!identity) {
      await reply.code(401).send({ error: 'invalid-credentials' });
      return;
    }
    const user = await deps.identityResolver.resolve(identity);
    const { token } = await deps.sessionService.create({
      userId: user.id,
      principalKind: 'human',
      ttlSeconds: SESSION_TTL_SECONDS,
      userAgent: req.headers['user-agent'] ?? null,
      ipAddress: req.ip,
    });
    setSessionCookie(reply, token, deps.cookieSecure);
    await recordAuthEvent(deps, 'auth.login', user.id, 'user', user.id, {
      provider: identity.provider, subject: identity.subject,
    });
    // Redirect to the app shell — the session is now observable synchronously.
    await reply.redirect(302, '/');
  });

  // -------------------------------------------------------------------------
  // Logout + current principal.
  // -------------------------------------------------------------------------

  app.post('/auth/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readCookie(req, SESSION_COOKIE_NAME);
    if (token) {
      await deps.sessionService.revoke(token);
    }
    // Record the logout against the resolved principal (if any).
    const principal = req.resolvedPrincipal;
    if (principal && principal.kind === 'human') {
      await recordAuthEvent(deps, 'auth.logout', principal.user.id, 'user', principal.user.id, {});
    }
    reply.header(
      'Set-Cookie',
      cookieHeader(SESSION_COOKIE_NAME, '', {
        httpOnly: true,
        sameSite: 'lax',
        secure: deps.cookieSecure ?? false,
        path: SESSION_COOKIE_PATH,
        maxAge: 0,
      }),
    );
    await reply.code(204).send();
  });

  app.get('/auth/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = req.resolvedPrincipal;
    if (!principal) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    if (principal.kind === 'human') {
      await reply.code(200).send({ user: publicUser(principal.user), kind: 'human' });
      return;
    }
    await reply.code(200).send({
      kind: 'machine',
      serviceAccount: {
        id: principal.serviceAccount.id,
        name: principal.serviceAccount.name,
        organizationId: principal.serviceAccount.organizationId,
        capabilities: principal.capabilities,
      },
    });
  });

  // -------------------------------------------------------------------------
  // Service accounts (machine principals) + scoped API credentials.
  // -------------------------------------------------------------------------

  app.post('/auth/service-accounts', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as CreateServiceAccountBody;
    if (!body || typeof body.organizationId !== 'string' || typeof body.name !== 'string'
      || !Array.isArray(body.capabilities)) {
      await reply.code(400).send({ error: 'invalid-request' });
      return;
    }
    const user = await requireUser(req, reply);
    // Only an org admin (or owner) may create a service account in that org.
    const decision = await deps.authorizationService.authorizeForOrganization({
      user,
      permission: 'org.admin',
      organizationId: body.organizationId,
    });
    if (!decision.allowed) {
      await reply.code(403).send({ error: 'forbidden', reason: decision.deniedReason });
      return;
    }
    const sa = await deps.serviceAccountRepository.create({
      organizationId: body.organizationId,
      name: body.name,
      capabilities: body.capabilities,
      createdBy: user.id,
    });
    // Audit the machine-principal creation + the granted capability set (a
    // role/capability change — recorded on the /audit surface, invariant #12).
    await recordAuthEvent(deps, 'service-account.create', user.id, 'service-account', sa.id, {
      organizationId: sa.organizationId,
      name: sa.name,
      capabilities: sa.capabilities,
    });
    await reply.code(201).send({ serviceAccount: sa });
  });

  app.get('/auth/service-accounts', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as { organizationId?: string };
    if (!query.organizationId) {
      await reply.code(400).send({ error: 'organizationId required' });
      return;
    }
    const user = await requireUser(req, reply);
    const decision = await deps.authorizationService.authorizeForOrganization({
      user,
      permission: 'project.read',
      organizationId: query.organizationId,
    });
    if (!decision.allowed) {
      await reply.code(403).send({ error: 'forbidden', reason: decision.deniedReason });
      return;
    }
    const list = await deps.serviceAccountRepository.listForOrganization(query.organizationId);
    await reply.code(200).send({ serviceAccounts: list });
  });

  app.post(
    '/auth/service-accounts/:id/credentials',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const user = await requireUser(req, reply);
      const sa = await deps.serviceAccountRepository.findById(id);
      if (!sa) {
        await reply.code(404).send({ error: 'not-found' });
        return;
      }
      const decision = await deps.authorizationService.authorizeForOrganization({
        user,
        permission: 'org.admin',
        organizationId: sa.organizationId,
      });
      if (!decision.allowed) {
        await reply.code(403).send({ error: 'forbidden', reason: decision.deniedReason });
        return;
      }
      // Generate a raw key, place it in the SecretStore (env), persist only the
      // digest + the opaque reference. The raw key is returned ONCE here.
      const rawKey = `wfos_${randomBytes(24).toString('base64url')}`;
      const keyId = `sa-${sa.id}-${Date.now()}`;
      // The opaque SecretStore reference (env var name) the operator places
      // the raw key at. The digest is persisted; the raw value is NOT.
      const effectiveRef = deps.apiKeySecretStoreRef(keyId);
      await deps.apiKeyProvisioner.provision({
        keyId,
        secretRef: effectiveRef,
        externalId: `service-account:${sa.id}`,
        label: `${sa.name} (scoped)`,
        rawKey,
        serviceAccountId: sa.id,
        scopes: sa.capabilities, // credential scoped to the service account's full set (narrow at provision time)
      });
      // Return the raw key ONCE. The digest is persisted; the raw value is not.
      // Audit the credential issuance (NOT the raw key — only the key id +
      // service account + scopes, which are safe to record, invariant #12).
      await recordAuthEvent(deps, 'credential.issue', user.id, 'api-key-credential', keyId, {
        serviceAccountId: sa.id,
        scopes: sa.capabilities,
        // Deliberately NO rawKey — raw key material never enters audit records.
      });
      await reply.code(201).send({
        keyId,
        rawKey,
        serviceAccountId: sa.id,
        scopes: sa.capabilities,
        // The operator must place `rawKey` in the secret store at `effectiveRef`.
        secretRef: effectiveRef,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EmailSignupBody {
  email?: string;
  password?: string;
  displayName?: string;
}
interface EmailLoginBody {
  email?: string;
  password?: string;
}
interface CreateServiceAccountBody {
  organizationId?: string;
  name?: string;
  capabilities?: string[];
}

interface PublicUser {
  id: string;
  externalId: string;
  displayName: string;
  email: string | null;
}

function publicUser(user: { id: string; externalId: string; displayName: string; email: string | null }): PublicUser {
  return {
    id: user.id,
    externalId: user.externalId,
    displayName: user.displayName,
    email: user.email,
  };
}

function setSessionCookie(reply: FastifyReply, token: string, secure?: boolean): void {
  reply.header(
    'Set-Cookie',
    cookieHeader(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secure ?? false,
      path: SESSION_COOKIE_PATH,
      maxAge: SESSION_TTL_SECONDS,
    }),
  );
}

interface CookieOpts {
  httpOnly?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  secure?: boolean;
  path?: string;
  maxAge?: number;
}

/** Build a single Set-Cookie header value (no @fastify/cookie dependency). */
function cookieHeader(name: string, value: string, opts: CookieOpts): string {
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${capitalize(opts.sameSite)}`);
  if (opts.secure) parts.push('Secure');
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (typeof opts.maxAge === 'number') parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Read a named cookie from the Cookie header (manual parse). */
function readCookie(req: FastifyRequest, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      const value = v.join('=').trim();
      return value.length > 0 ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

function callbackUrl(publicBaseUrl: string | undefined, provider: string): string {
  const base = publicBaseUrl ?? 'http://localhost:3001';
  return `${base.replace(/\/$/, '')}/auth/callback/${provider}`;
}

/**
 * Record an auth-domain audit event (WORK-074 invariant #12). Uses the existing
 * {@link AuditEventWriter} application boundary — no second audit authority.
 * Raw credentials/session/provider tokens are NEVER included in `metadata`.
 */
async function recordAuthEvent(
  deps: AuthRouteDeps,
  eventType: string,
  actor: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!deps.auditWriter) return;
  try {
    await deps.auditWriter.write({
      eventType,
      actor,
      source: 'auth-runtime',
      resourceType,
      resourceId,
      metadata,
    });
  } catch {
    // Audit failure must not break the auth flow (the audit trail is forensic,
    // not authoritative for the login decision). Logged by the writer itself.
  }
}

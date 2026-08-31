import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AuthProvider,
  AuthorizationService,
  AuthenticatedPrincipal,
  Principal,
} from '@modules/auth/index.js';
import type { User, UserRepository } from '@modules/users/index.js';
import type { RequestAuthenticator } from '@modules/auth/index.js';
import { runWithExecutionContext } from '@platform/execution-context.js';

/**
 * Fastify authentication plugin (AUTH-001, AUTH-AC-02, WORK-074 runtime).
 *
 * Resolves an inbound request to a {@link Principal} (human OR machine) by:
 *
 *   - the session cookie (human browser login) → SessionService → resolved
 *     WorkflowOS user; OR
 *   - the API key (Authorization: Bearer / X-API-Key) → ApiKeyAuthProvider →
 *     a human user (existing path) OR a machine service account (WORK-074).
 *
 * When a {@link RequestAuthenticator} is provided (production wiring), it is
 * the canonical resolver and produces a {@link Principal} that distinguishes
 * human from machine. When absent (legacy wiring / existing tests), the plugin
 * falls back to the WORK-002 path: `authProvider.authenticate` +
 * `userRepository.upsertByExternalId`.
 *
 * Authentication and authorization remain SEPARATED (WORK-063 invariant #1):
 * this plugin does NOT make authorization decisions — that is the
 * {@link AuthorizationService}'s job (AUTHZ-AC-01..03).
 */

/** The httpOnly cookie name carrying the opaque session token. */
export const SESSION_COOKIE_NAME = 'wfos_session';

export interface AuthPluginDeps {
  /** Legacy WORK-002 auth provider (used when requestAuthenticator is absent). */
  authProvider: AuthProvider;
  userRepository: UserRepository;
  /** WORK-074 runtime authenticator (session + API key → Principal). */
  requestAuthenticator?: RequestAuthenticator;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal | null;
    /** The resolved WORK-074 Principal (human OR machine). */
    resolvedPrincipal?: Principal | null;
    user?: User | null;
  }
}

export async function authPlugin(app: FastifyInstance, deps: AuthPluginDeps): Promise<void> {
  app.addHook('onRequest', async (req: FastifyRequest, _reply: FastifyReply) => {
    if (deps.requestAuthenticator) {
      // WORK-074 canonical path: session cookie OR API key → Principal.
      const sessionToken = readSessionCookie(req);
      const apiKey = extractApiKey(req);
      const principal = await deps.requestAuthenticator.authenticateRequest({
        sessionToken,
        apiKey,
      });
      if (principal) {
        req.resolvedPrincipal = principal;
        req.user = principal.kind === 'human' ? principal.user : null;
        req.principal = principal.kind === 'human'
          ? { externalId: principal.user.externalId, label: principal.user.displayName, provider: principal.provider }
          : { externalId: principal.serviceAccount.id, label: principal.serviceAccount.name, provider: principal.provider };
      } else {
        req.resolvedPrincipal = null;
        req.principal = null;
        req.user = null;
      }
      return;
    }

    // Legacy WORK-002 path (existing tests, no runtime authenticator wired).
    const raw = extractApiKey(req);
    if (!raw) {
      req.principal = null;
      req.user = null;
      req.resolvedPrincipal = null;
      return;
    }
    const result = await deps.authProvider.authenticate(raw);
    if (result.kind !== 'principal') {
      req.principal = null;
      req.user = null;
      req.resolvedPrincipal = null;
      return;
    }
    req.principal = result.principal;
    const user = await deps.userRepository.upsertByExternalId({
      externalId: result.principal.externalId,
      displayName: result.principal.label,
    });
    req.user = user;
    req.resolvedPrincipal = { kind: 'human', user, provider: result.principal.provider };
  });
}

/** Read the opaque session token from the request cookies. */
function readSessionCookie(req: FastifyRequest): string | null {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE_NAME) {
      const value = v.join('=').trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** Extract a raw API key from request headers. */
export function extractApiKey(req: FastifyRequest): string | null {
  const bearer = req.headers.authorization;
  if (typeof bearer === 'string' && bearer.toLowerCase().startsWith('bearer ')) {
    return bearer.slice(7).trim() || null;
  }
  const xKey = req.headers['x-api-key'];
  if (typeof xKey === 'string' && xKey.length > 0) return xKey;
  return null;
}

/**
 * Route helper: require an authenticated HUMAN user. Sends 401 if absent (or
 * if the principal is a machine — a machine principal is NEVER a human user,
 * WORK-063 invariant #3). Returns the user when present.
 */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<User> {
  const principal = req.resolvedPrincipal;
  if (!principal || principal.kind !== 'human' || !req.user) {
    await reply.code(401).send({ error: 'unauthenticated' });
    throw new Error('unauthenticated');
  }
  return req.user;
}

/**
 * Route helper: require any authenticated Principal (human OR machine). Used
 * by routes that accept either principal kind.
 */
export async function requirePrincipal(req: FastifyRequest, reply: FastifyReply): Promise<Principal> {
  const principal = req.resolvedPrincipal;
  if (!principal) {
    await reply.code(401).send({ error: 'unauthenticated' });
    throw new Error('unauthenticated');
  }
  return principal;
}

export interface RequireAuthorizationDeps {
  authorizationService: AuthorizationService;
}

/**
 * Route helper: require an authorization decision for a project resource.
 * Sends 403 when denied. HUMAN-only (returns the {@link User}); a machine
 * principal is rejected with 403 (these routes are the existing human-only
 * product surface — machine principals use
 * {@link requirePrincipalProjectAuthorization}).
 *
 * Backend-owned — frontend checks are irrelevant (AUTHZ-AC-03).
 */
export async function requireProjectAuthorization(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: RequireAuthorizationDeps,
  input: { permission: string; projectId: string },
): Promise<User> {
  const user = await requireUser(req, reply);
  const decision = await deps.authorizationService.authorize({
    user,
    permission: input.permission,
    resource: { kind: 'project', projectId: input.projectId },
  });
  if (!decision.allowed) {
    await reply.code(403).send({
      error: 'forbidden',
      reason: decision.deniedReason,
      permission: input.permission,
      projectId: input.projectId,
    });
    throw new Error('forbidden');
  }
  return user;
}

/**
 * WORK-074: principal-aware authorization for a project resource. Dispatches
 * on principal kind: humans use the role → permission path; machines use the
 * capability → permission path (the SAME {@link AuthorizationService}, never a
 * parallel mechanism — WORK-063 invariant #13).
 */
export async function requirePrincipalProjectAuthorization(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: RequireAuthorizationDeps,
  input: { permission: string; projectId: string },
): Promise<Principal> {
  const principal = await requirePrincipal(req, reply);
  if (principal.kind === 'human') {
    const decision = await deps.authorizationService.authorize({
      user: principal.user,
      permission: input.permission,
      resource: { kind: 'project', projectId: input.projectId },
    });
    if (!decision.allowed) {
      await reply.code(403).send({
        error: 'forbidden', reason: decision.deniedReason,
        permission: input.permission, projectId: input.projectId,
      });
      throw new Error('forbidden');
    }
    return principal;
  }
  const decision = await deps.authorizationService.authorizeMachine({
    serviceAccount: principal.serviceAccount,
    capabilities: principal.capabilities,
    permission: input.permission,
    resource: { kind: 'project', projectId: input.projectId },
  });
  if (!decision.allowed) {
    await reply.code(403).send({
      error: 'forbidden', reason: decision.deniedReason,
      permission: input.permission, projectId: input.projectId,
    });
    throw new Error('forbidden');
  }
  return principal;
}

/**
 * Route helper: require an authorization decision for an organization-level
 * operation (e.g. creating a project within an org). Sends 403 when denied.
 * HUMAN-only (returns the {@link User}); uses the reusable
 * {@link AuthorizationService.authorizeForOrganization} — no synthetic project
 * id, no ad-hoc membership logic.
 */
export async function requireOrganizationAuthorization(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: RequireAuthorizationDeps,
  input: { permission: string; organizationId: string },
): Promise<User> {
  const user = await requireUser(req, reply);
  const decision = await deps.authorizationService.authorizeForOrganization({
    user,
    permission: input.permission,
    organizationId: input.organizationId,
  });
  if (!decision.allowed) {
    await reply.code(403).send({
      error: 'forbidden',
      reason: decision.deniedReason,
      permission: input.permission,
      organizationId: input.organizationId,
    });
    throw new Error('forbidden');
  }
  return user;
}

/**
 * Run a handler inside the request's execution context (so logs/audit carry
 * the execution id). Convenience for authed routes.
 */
export async function runAuthed<T>(
  req: FastifyRequest,
  fn: () => Promise<T>,
): Promise<T> {
  const executionId =
    (req as unknown as { executionId?: string }).executionId ?? 'unknown';
  return runWithExecutionContext({ executionId, requestId: req.id }, fn);
}

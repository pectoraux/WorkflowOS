import { buildAuthStack, type TestAuthStack } from './test-auth-stack.js';
import { DefaultAuthorizationService, ApiKeyCredentialProvisioner } from '../../src/modules/auth/internal/authorization-service.js';
import { ApiKeyAuthProvider } from '../../src/modules/auth/internal/api-key-auth-provider.js';
import { PgSessionService } from '../../src/modules/auth/internal/pg-session-service.js';
import {
  PgServiceAccountRepository,
  PgCapabilityPermissionRepository,
} from '../../src/modules/auth/internal/pg-service-account-repository.js';
import {
  PgUserIdentityRepository,
  PgUserPasswordRepository,
} from '../../src/modules/auth/internal/pg-user-identity-repository.js';
import { EmailAuthProvider } from '../../src/modules/auth/internal/email-auth-provider.js';
import { IdentityResolver } from '../../src/modules/auth/internal/identity-resolver.js';
import { RequestAuthenticator } from '../../src/modules/auth/internal/request-authenticator.js';
import {
  GoogleOidcProvider,
  GitHubOAuthProvider,
} from '../../src/modules/auth/internal/oauth-provider.js';
import type { OAuthHttpClient, OAuthProvider } from '@modules/auth/index.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { authRoutes } from '../../src/api/routes/auth.route.js';

/**
 * WORK-074 test harness — the full identity & access runtime stack on a real
 * PostgreSQL (pglite locally / real pg in CI). Extends the WORK-002
 * {@link buildAuthStack} with the runtime: sessions, service accounts, identity
 * linking, email/password, OAuth/OIDC providers (with an injectable HTTP
 * client for controlled provider responses), and the request authenticator.
 *
 * Also builds a Fastify server with the auth runtime wired (for HTTP-level
 * proofs: cookie session, /auth/me, protected-route rejection).
 */
export interface TestRuntimeStack extends TestAuthStack {
  sessionService: PgSessionService;
  serviceAccountRepository: PgServiceAccountRepository;
  capabilityPermissionRepository: PgCapabilityPermissionRepository;
  userIdentityRepository: PgUserIdentityRepository;
  userPasswordRepository: PgUserPasswordRepository;
  emailProvider: EmailAuthProvider;
  identityResolver: IdentityResolver;
  requestAuthenticator: RequestAuthenticator;
  // The runtime authorization service (constructed WITH capabilityPermissions
  // so the machine path works). Replaces the authStack.authorizationService for
  // runtime proofs.
  runtimeAuthorizationService: DefaultAuthorizationService;
  apiKeyProvider: ApiKeyAuthProvider;
  apiKeyProvisioner: ApiKeyCredentialProvisioner;
  secretStore: EnvSecretStore;
}

export interface BuildRuntimeOptions {
  /** Env vars to place in the EnvSecretStore (e.g. OAuth client secrets). */
  envSecrets?: Record<string, string>;
  /** Optional OAuth providers to register (with their configs). */
  oauthProviders?: Record<string, OAuthProvider>;
}

export async function buildRuntimeStack(
  options: BuildRuntimeOptions = {},
): Promise<TestRuntimeStack> {
  const stack = await buildAuthStack(options.envSecrets ?? {});
  const db = stack.db.client;
  const secretStore = stack.secretStore;

  // Runtime repositories.
  const sessionService = new PgSessionService(db);
  const serviceAccountRepository = new PgServiceAccountRepository(db);
  const capabilityPermissionRepository = new PgCapabilityPermissionRepository(db);
  const userIdentityRepository = new PgUserIdentityRepository(db);
  const userPasswordRepository = new PgUserPasswordRepository(db);

  // Runtime providers + services.
  const apiKeyProvider = new ApiKeyAuthProvider(db, secretStore);
  const emailProvider = new EmailAuthProvider(
    stack.userRepository,
    userIdentityRepository,
    userPasswordRepository,
  );
  const identityResolver = new IdentityResolver(stack.userRepository, userIdentityRepository);
  const requestAuthenticator = new RequestAuthenticator(
    apiKeyProvider,
    sessionService,
    stack.userRepository,
    serviceAccountRepository,
  );
  // Runtime authorization service WITH the capability → permission mapping.
  const runtimeAuthorizationService = new DefaultAuthorizationService(
    stack.membershipRepository,
    stack.rolePermissionRepository,
    stack.projectRepository,
    stack.projectAccessRepository,
    capabilityPermissionRepository,
  );

  return {
    ...stack,
    sessionService,
    serviceAccountRepository,
    capabilityPermissionRepository,
    userIdentityRepository,
    userPasswordRepository,
    emailProvider,
    identityResolver,
    requestAuthenticator,
    runtimeAuthorizationService,
    apiKeyProvider,
    apiKeyProvisioner: stack.apiKeyProvisioner,
    secretStore,
  };
}

/**
 * Build a Fastify server with the WORK-074 auth runtime wired (the auth plugin
 * uses the RequestAuthenticator; the auth routes are registered). Used for
 * HTTP-level proofs (cookie session, /auth/me, protected-route rejection,
 * logout). The server is NOT started; tests use `app.inject(...)`.
 */
export async function buildRuntimeServer(stack: TestRuntimeStack, options: {
  oauthProviders?: Record<string, OAuthProvider>;
  auditWriter?: { write: (input: unknown) => Promise<unknown> };
} = {}): Promise<{
  app: import('fastify').FastifyInstance;
  close: () => Promise<void>;
}> {
  const { buildServer } = await import('../../src/api/server.js');
  const app = await buildServer({
    queue: new InMemoryQueue(),
    logger: stack.db.logger,
    auth: {
      authProvider: stack.apiKeyProvider,
      userRepository: stack.userRepository,
      requestAuthenticator: stack.requestAuthenticator,
    },
    // Wire the protected /projects route so HTTP proofs can exercise the
    // authorization chain through a real protected route (login → session →
    // project.read / project.write, allowed + denied cases).
    projects: {
      authorizationService: stack.runtimeAuthorizationService,
      projectRepository: stack.projectRepository,
      repositoryAssociationRepository: stack.repositoryAssociationRepository,
      projectAccessRepository: stack.projectAccessRepository,
      membershipRepository: stack.membershipRepository,
      organizationRepository: stack.organizationRepository,
    },
    authRuntime: {
      sessionService: stack.sessionService,
      emailProvider: stack.emailProvider,
      identityResolver: stack.identityResolver,
      userRepository: stack.userRepository,
      organizationRepository: stack.organizationRepository,
      membershipRepository: stack.membershipRepository,
      serviceAccountRepository: stack.serviceAccountRepository,
      apiKeyProvisioner: stack.apiKeyProvisioner,
      apiKeySecretStoreRef: (keyId: string) =>
        `WFOS_TEST_SA_KEY_${keyId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
      secretsEnv: {
        getSecret: (key: string) => Promise.resolve(process.env[key] ?? null),
      },
      ...(options.oauthProviders ? { oauthProviders: options.oauthProviders } : {}),
      publicBaseUrl: 'http://localhost:3001',
      cookieSecure: false,
      authorizationService: stack.runtimeAuthorizationService,
      ...(options.auditWriter ? { auditWriter: options.auditWriter as never } : {}),
    },
  });
  // Register the auth routes explicitly too (buildServer already does, but be
  // explicit in case the wiring option is renamed). This is a no-op if already
  // registered. Actually buildServer registers authRuntime when present; skip.
  void authRoutes;
  return { app, close: async () => { await app.close(); } };
}

/**
 * A controlled OAuth HTTP client for tests. Returns real-shaped OIDC responses
 * for a configured subject/email. Proves the OAuth code path against real
 * provider semantics without live Google/GitHub.
 */
export function mockOAuthHttpClient(opts: {
  subject: string;
  email?: string;
  name?: string;
  accessToken?: string;
}): OAuthHttpClient {
  const accessToken = opts.accessToken ?? 'mock-access-token';
  return {
    async postForm(_url: string, _params: Record<string, string>) {
      return {
        status: 200,
        json: async () => ({ access_token: accessToken, token_type: 'Bearer' }),
      };
    },
    async getJson(_url: string, _bearerToken: string) {
      // Google-style userinfo (sub/email/name) — also works for GitHub via the
      // provider-specific parsing in GitHubOAuthProvider (id/login/name/email).
      return {
        status: 200,
        json: async () => ({
          sub: opts.subject,
          id: Number(opts.subject) || undefined,
          email: opts.email ?? `${opts.subject}@example.com`,
          name: opts.name ?? 'OAuth Test User',
          login: opts.name ?? 'oauth-test-user',
        }),
      };
    },
  };
}

/**
 * Build a Google OIDC provider with a controlled HTTP client + a known
 * client secret placed in the EnvSecretStore.
 */
export function buildMockGoogleProvider(
  secretStore: EnvSecretStore,
  envSecrets: Record<string, string>,
  http: OAuthHttpClient,
  clientId = 'mock-google-client-id',
): { provider: OAuthProvider; clientSecretRef: string } {
  const clientSecretRef = 'WORKFLOWOS_TEST_GOOGLE_SECRET';
  process.env[clientSecretRef] = envSecrets[clientSecretRef] ?? 'mock-google-secret';
  const provider = new GoogleOidcProvider(
    {
      clientId,
      clientSecretRef,
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email profile',
    },
    secretStore,
    http,
  );
  return { provider, clientSecretRef };
}

/**
 * Build a GitHub OAuth provider with a controlled HTTP client.
 */
export function buildMockGitHubProvider(
  secretStore: EnvSecretStore,
  envSecrets: Record<string, string>,
  http: OAuthHttpClient,
  clientId = 'mock-github-client-id',
): { provider: OAuthProvider; clientSecretRef: string } {
  const clientSecretRef = 'WORKFLOWOS_TEST_GITHUB_SECRET';
  process.env[clientSecretRef] = envSecrets[clientSecretRef] ?? 'mock-github-secret';
  const provider = new GitHubOAuthProvider(
    {
      clientId,
      clientSecretRef,
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userinfoUrl: 'https://api.github.com/user',
      scope: 'read:user user:email',
    },
    secretStore,
    http,
  );
  return { provider, clientSecretRef };
}

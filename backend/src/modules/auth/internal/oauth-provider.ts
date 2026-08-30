import { randomBytes, createHash } from 'node:crypto';
import type { SecretStore } from '@platform/secrets/secret-store.js';
import type {
  OAuthProvider,
  OAuthHttpClient,
  ExternalIdentity,
} from './identity-runtime.types.js';

/**
 * OAuth/OIDC providers (Google + GitHub) — WORK-074.
 *
 * A new provider is a new adapter behind the existing /auth boundary, never a
 * new authority (WORK-063). Each provider implements the OIDC/OAuth
 * authorization-code flow:
 *
 *   1. browser → GET /auth/login/<provider> → 302 to provider authorization URL
 *   2. provider → GET /auth/callback/<provider>?code=...&state=...
 *   3. backend exchanges code for tokens (client_secret from SecretStore)
 *   4. backend fetches userinfo → resolves the OIDC subject
 *   5. IdentityResolver maps subject → WorkflowOS user → session cookie set
 *
 * SECURITY: the OAuth client_secret is read from the SecretStore (env) and
 * used ONLY for the token-exchange POST. It is NEVER sent to the browser,
 * NEVER logged, NEVER persisted in a domain record. The provider access/refresh
 * tokens are used ephemerally to fetch userinfo, then discarded (the session
 * cookie is the WorkflowOS session, not the provider token).
 *
 * CSRF/state: a high-entropy `state` is generated per login; the callback
 * verifies state matches a pending flow (the route layer stores pending states
 * in a short-lived signed cookie / in-memory map). This prevents login CSRF.
 *
 * Testability: the {@link OAuthHttpClient} is injectable. Production uses
 * {@link fetchOAuthHttpClient}; tests inject a controlled client returning
 * real-shaped OIDC responses — proving the OAuth code path against real
 * provider semantics without live Google/GitHub.
 */

export interface OAuthProviderConfig {
  /** The OAuth client id (NOT secret — sent to the provider in the URL). */
  clientId: string;
  /** SecretStore key holding the client secret. */
  clientSecretRef: string;
  /** The provider's authorization endpoint. */
  authorizeUrl: string;
  /** The provider's token endpoint. */
  tokenUrl: string;
  /** The provider's userinfo endpoint. */
  userinfoUrl: string;
  /** The scopes to request. */
  scope: string;
}

/**
 * Google OIDC provider (WORK-074 — Google authentication, per WORK-063).
 *
 * Uses Google's OAuth 2.0 + OpenID Connect: the userinfo endpoint returns the
 * stable `sub` (the OIDC subject), email, and name.
 */
export class GoogleOidcProvider implements OAuthProvider {
  readonly name = 'google';

  constructor(
    private readonly config: OAuthProviderConfig,
    private readonly secrets: SecretStore,
    private readonly http: OAuthHttpClient,
  ) {}

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.config.scope,
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    _state: string,
    redirectUri: string,
  ): Promise<ExternalIdentity | null> {
    const secretRef = this.secrets.ref(this.config.clientSecretRef);
    const clientSecret = await this.secrets.getSecret(secretRef);
    if (!clientSecret) return null;
    const tokenRes = await this.http.postForm(this.config.tokenUrl, {
      code,
      client_id: this.config.clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (tokenRes.status !== 200) return null;
    const tokenBody = (await tokenRes.json()) as {
      access_token?: string;
    };
    const accessToken = tokenBody.access_token;
    if (!accessToken) return null;
    const userRes = await this.http.getJson(this.config.userinfoUrl, accessToken);
    if (userRes.status !== 200) return null;
    const info = (await userRes.json()) as GoogleUserinfo;
    if (!info.sub) return null;
    return {
      provider: 'google',
      subject: info.sub,
      displayName: info.name || info.email || 'Google User',
      email: info.email ?? null,
    };
  }
}

interface GoogleUserinfo {
  sub?: string;
  email?: string;
  name?: string;
}

/**
 * GitHub OAuth provider (WORK-074 — GitHub authentication, per WORK-063).
 *
 * GitHub's OAuth: the /user endpoint returns the stable `id` (numeric, used
 * as the subject) + login + email. GitHub's token endpoint returns
 * access_token as JSON (or form-encoded; we request JSON via Accept header).
 */
export class GitHubOAuthProvider implements OAuthProvider {
  readonly name = 'github';

  constructor(
    private readonly config: OAuthProviderConfig,
    private readonly secrets: SecretStore,
    private readonly http: OAuthHttpClient,
  ) {}

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      scope: this.config.scope,
      state,
    });
    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    _state: string,
    redirectUri: string,
  ): Promise<ExternalIdentity | null> {
    const secretRef = this.secrets.ref(this.config.clientSecretRef);
    const clientSecret = await this.secrets.getSecret(secretRef);
    if (!clientSecret) return null;
    const tokenRes = await this.http.postForm(this.config.tokenUrl, {
      code,
      client_id: this.config.clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });
    if (tokenRes.status !== 200) return null;
    const tokenBody = (await tokenRes.json()) as {
      access_token?: string;
    };
    const accessToken = tokenBody.access_token;
    if (!accessToken) return null;
    const userRes = await this.http.getJson(this.config.userinfoUrl, accessToken);
    if (userRes.status !== 200) return null;
    const info = (await userRes.json()) as GitHubUserinfo;
    if (!info.id) return null;
    return {
      provider: 'github',
      subject: String(info.id),
      displayName: info.name || info.login || 'GitHub User',
      email: info.email ?? null,
    };
  }
}

interface GitHubUserinfo {
  id?: number;
  login?: string;
  name?: string;
  email?: string | null;
}

/**
 * Default OAuth HTTP client backed by the global `fetch`. Used in production;
 * tests inject a controlled {@link OAuthHttpClient}.
 */
export function fetchOAuthHttpClient(): OAuthHttpClient {
  return {
    async postForm(url, params) {
      const body = new URLSearchParams(params);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      });
      return {
        status: res.status,
        json: async () => res.json(),
      };
    },
    async getJson(url, bearerToken) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: 'application/json',
          // GitHub's API requires a User-Agent.
          'User-Agent': 'WorkflowOS',
        },
      });
      return {
        status: res.status,
        json: async () => res.json(),
      };
    },
  };
}

/**
 * Generate a high-entropy OAuth `state` parameter for CSRF protection. The
 * route layer stores the pending state (signed cookie or in-memory map) and
 * verifies it on callback.
 */
export function generateOAuthState(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Derive a short, stable HMAC-style fingerprint of a state for log/metrics
 * (NEVER the state itself — the state is a session secret). Used for audit
 * logs that must reference a login flow without exposing the verifiable state.
 */
export function stateFingerprint(state: string): string {
  return createHash('sha256').update(state).digest('hex').slice(0, 12);
}

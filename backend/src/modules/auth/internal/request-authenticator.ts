import type { UserRepository } from '@modules/users/index.js';
import type { ApiKeyAuthProvider } from './api-key-auth-provider.js';
import type { SessionService } from './identity-runtime.types.js';
import type { ServiceAccountRepository } from './identity-runtime.types.js';
import type { Principal } from './identity-runtime.types.js';

/**
 * RequestAuthenticator — the runtime authentication orchestrator (WORK-074).
 *
 * Resolves an inbound request to a {@link Principal} (human OR machine) by
 * trying, in order:
 *
 *   1. the session cookie (human browser login) → SessionService.verify →
 *      resolve user by session.user_id → HumanPrincipal;
 *   2. the API-key header (Bearer / X-API-Key) → ApiKeyAuthProvider.
 *      resolveCredential → if the credential carries a service_account_id,
 *      resolve the service account + the credential's effective capabilities
 *      (intersection of the service account's capabilities and the credential's
 *      scopes) → MachinePrincipal; otherwise resolve the user → HumanPrincipal.
 *
 * Authentication and authorization remain SEPARATED (WORK-063 invariant #1):
 * this layer produces a Principal; the AuthorizationService decides what the
 * Principal may do. A machine principal is NEVER a human user (invariant #3):
 * the two are distinct types that never confuse.
 *
 * SECURITY: raw session tokens and raw API keys are NEVER persisted and NEVER
 * logged. They are matched by digest (session) / digest + SecretStore
 * double-check (API key) and discarded.
 */

export interface AuthenticateRequestInput {
  /** The raw session token from the cookie, if present. */
  sessionToken?: string | null;
  /** The raw API key from the Authorization/X-API-Key header, if present. */
  apiKey?: string | null;
}

export class RequestAuthenticator {
  constructor(
    private readonly apiKeyProvider: ApiKeyAuthProvider,
    private readonly sessionService: SessionService,
    private readonly users: UserRepository,
    private readonly serviceAccounts: ServiceAccountRepository,
  ) {}

  async authenticateRequest(
    input: AuthenticateRequestInput,
  ): Promise<Principal | null> {
    // 1. Session cookie path (human browser login).
    if (input.sessionToken) {
      const verified = await this.sessionService.verify(input.sessionToken);
      if (!verified.valid) return null;
      const user = await this.users.findById(verified.session.userId);
      if (!user) return null;
      return { kind: 'human', user, provider: 'session' };
    }

    // 2. API-key path (human automation OR machine service-account credential).
    if (input.apiKey) {
      const cred = await this.apiKeyProvider.resolveCredential(input.apiKey);
      if (!cred) return null;

      // Machine principal: the credential is scoped to a service account.
      if (cred.serviceAccountId) {
        const sa = await this.serviceAccounts.findById(cred.serviceAccountId);
        if (!sa) return null;
        // Effective capabilities = intersection of the service account's
        // capabilities and the credential's scopes (fail closed: a capability
        // not in BOTH is denied, WORK-063 invariant #6).
        const effective = sa.capabilities.filter((c) => cred.scopes.includes(c));
        return {
          kind: 'machine',
          serviceAccount: sa,
          provider: 'apikey',
          capabilities: effective,
        };
      }

      // Human credential (the existing API-key path).
      const user = await this.users.upsertByExternalId({
        externalId: cred.externalId,
        displayName: cred.label,
      });
      return { kind: 'human', user, provider: 'apikey' };
    }

    return null;
  }
}

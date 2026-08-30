import type { UserRepository, User } from '@modules/users/index.js';
import type {
  ExternalIdentity,
  UserIdentityRepository,
} from './identity-runtime.types.js';

/**
 * Identity resolution — AUTH-AC-01 generalized from the API-key precedent to
 * OIDC subjects and email subjects (WORK-063).
 *
 * The SAME provider subject always resolves to the SAME WorkflowOS user. On
 * first login, a user is created and the provider identity is linked. On a
 * linked re-login, the existing user is resolved (deterministic). Multiple
 * provider identities may link to one user (identity linking, WORK-063 proof
 * #3): a user who first signs in with Google and later links GitHub resolves
 * to the SAME user on both logins.
 *
 * External identity providers are authoritative ONLY for their authentication
 * assertion (the subject). WorkflowOS authorization state (memberships,
 * roles, project access) remains in PostgreSQL (WORK-063 invariant #14).
 */
export class IdentityResolver {
  constructor(
    private readonly users: UserRepository,
    private readonly identities: UserIdentityRepository,
  ) {}

  /**
   * Resolve an external identity to a WorkflowOS user. Creates the user on
   * first login (the user's `externalId` is derived from provider+subject so
   * resolution is deterministic even before the identity row exists — defense
   * in depth with the wfos_user_identities UNIQUE(provider, subject)).
   */
  async resolve(identity: ExternalIdentity): Promise<User> {
    const existing = await this.identities.findByProviderAndSubject(
      identity.provider,
      identity.subject,
    );
    if (existing) {
      // Linked re-login: resolve the SAME user by its id (the identity row is
      // the source of truth for the link). Refresh display name/email so an
      // identity refresh propagates, but the user row is the linked one (NOT
      // a new user created from the external_id).
      const user = await this.users.findById(existing.userId);
      if (user) {
        // Propagate any refreshed display name/email from the provider.
        if (
          (identity.displayName && identity.displayName !== user.displayName) ||
          (identity.email !== undefined && identity.email !== user.email)
        ) {
          return this.users.upsertByExternalId({
            externalId: user.externalId,
            displayName: identity.displayName || user.displayName,
            email: identity.email ?? user.email,
          });
        }
        return user;
      }
      // Fall through: the identity row exists but the user was deleted —
      // recreate the user from the identity (defense in depth).
    }
    // First login (or orphaned identity): create the user + link the identity.
    // The external_id is derived from provider+subject so the wfos_users
    // UNIQUE(external_id) also enforces deterministic resolution (defense in
    // depth with wfos_user_identities UNIQUE(provider, subject)).
    const user = await this.users.upsertByExternalId({
      externalId: externalIdFor(identity),
      displayName: identity.displayName,
      email: identity.email,
    });
    await this.identities.link(user.id, identity.provider, identity.subject);
    return user;
  }
}

/**
 * Derive the stable `external_id` for an external identity. This makes the
 * wfos_users.external_id UNIQUE constraint ALSO enforce deterministic
 * resolution (defense in depth with wfos_user_identities UNIQUE(provider,
 * subject)): the same provider+subject always produces the same external_id,
 * so upsertByExternalId resolves to the same row.
 */
export function externalIdFor(identity: ExternalIdentity): string {
  return `${identity.provider}:${identity.subject}`;
}

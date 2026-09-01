import type { MembershipRepository } from '@modules/organizations/index.js';
import type { UserRepository } from '@modules/users/index.js';
import type {
  TenantMembership,
  TenantMembershipResolver,
  UserDirectory,
} from '../types.js';

/**
 * V2-002 — public-contract adapters over the V1 identity stack.
 *
 * V2-002 consumes existing V1 functionality ONLY through public module
 * contracts (`@modules/organizations/index.ts`, `@modules/users/index.ts`)
 * — never V1 module internals (constitution §18; static architecture tests
 * enforce the module-boundary discipline). The adapters are type-only: they
 * accept any implementation of the public repository contracts.
 */

/**
 * Adapt the V1 `/organizations` public {@link MembershipRepository} contract
 * into the V2-002 tenant-membership resolver port.
 */
export function membershipRepositoryAdapter(repo: MembershipRepository): TenantMembershipResolver {
  return {
    async resolve(userId: string, tenantId: string): Promise<TenantMembership | null> {
      const membership = await repo.findByUserAndOrganization(userId, tenantId);
      return membership ? { userId, tenantId, roleId: membership.roleId } : null;
    },
  };
}

/**
 * Adapt the V1 `/users` public {@link UserRepository} contract into the
 * V2-002 user-directory port.
 */
export function userDirectoryAdapter(repo: UserRepository): UserDirectory {
  return {
    async findById(userId: string): Promise<{ id: string } | null> {
      const user = await repo.findById(userId);
      return user ? { id: user.id } : null;
    },
  };
}

import { createHash } from 'node:crypto';
import type {
  AuthorizationService,
  AuthorizationDecision,
  OrganizationAuthorizationDecision,
  ProtectedResource,
} from './auth.types.js';
import type { User } from '@modules/users/index.js';
import type { MembershipRepository, RolePermissionRepository } from '@modules/organizations/index.js';
import type { ProjectRepository, ProjectAccessRepository } from '@modules/projects/index.js';
import type {
  ServiceAccount,
  CapabilityPermissionRepository,
} from './identity-runtime.types.js';

/**
 * Default backend {@link AuthorizationService} (AUTHZ-AC-01..03).
 *
 * Reusable: later modules ask it "may this principal exercise permission P on
 * resource R?" rather than reimplementing checks per route. Decisions are
 * server-side, independent of frontend state, and testable without HTTP.
 *
 * Decision chain for HUMAN principals (architecture §15, WORK-002 §15):
 *
 *   user → membership in the resource's owning org → role → permission
 *       → explicit project_access for the user on the project
 *
 * Decision chain for MACHINE principals (WORK-063 — the SAME service, the
 * capability → permission mapping):
 *
 *   service account → org ownership of the resource (tenant isolation)
 *                   → capability → permission mapping
 *                   → requested permission in the resolved set
 *
 * There is ONE authorization chain. The {@link DefaultAuthorizationService}
 * is the single authority; machine principals ENTER it through the
 * capability → permission mapping (the machine analog of role → permission),
 * never through a parallel authorization mechanism (WORK-063 invariant #13).
 *
 * Tenant isolation (AUTHZ-AC-02): for humans, a cross-tenant project_access
 * row alone is NOT sufficient — the user MUST be a member of the org that
 * owns the project. For machines, the service account's org MUST own the
 * project — a credential scoped to Org A cannot access Org B's project even
 * if the capability would otherwise grant the permission.
 */
export class DefaultAuthorizationService implements AuthorizationService {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly rolePermissions: RolePermissionRepository,
    private readonly projects: ProjectRepository,
    private readonly projectAccess: ProjectAccessRepository,
    /**
     * The capability → permission mapping for machine principals. Optional so
     * the human-only authorization stack (existing tests, existing wiring)
     * continues to construct without it; required for the machine path
     * (authorizeMachine throws if absent).
     */
    private readonly capabilityPermissions?: CapabilityPermissionRepository,
  ) {}

  async authorize(input: {
    user: User;
    permission: string;
    resource: ProtectedResource;
  }): Promise<AuthorizationDecision> {
    const { user, permission, resource } = input;
    if (resource.kind !== 'project') {
      // Only project resources are protected in WORK-002. Future resource
      // kinds are added by later work items.
      return {
        allowed: false,
        userId: user.id,
        permission,
        resource,
        organizationId: null,
        deniedReason: 'resource-not-found',
      };
    }

    // 1. Resolve the resource's owning organization.
    const project = await this.projects.findById(resource.projectId);
    if (!project) {
      return {
        allowed: false,
        userId: user.id,
        permission,
        resource,
        organizationId: null,
        deniedReason: 'resource-not-found',
      };
    }

    // 2. The user MUST be a member of the owning organization (AUTHZ-AC-02).
    const membership = await this.memberships.findByUserAndOrganization(
      user.id,
      project.organizationId,
    );
    if (!membership) {
      return {
        allowed: false,
        userId: user.id,
        permission,
        resource,
        organizationId: project.organizationId,
        deniedReason: 'not-a-member',
      };
    }

    // 3. The user's role (org-level OR project-level) MUST grant the permission.
    //    Org-level role: the membership role itself.
    //    Project-level role: a project_access row on this project.
    const orgPermissionIds = await this.rolePermissions.listPermissionsForUserInOrganization(
      user.id,
      project.organizationId,
    );
    const hasOrgPermission = orgPermissionIds.includes(permission);

    let hasProjectPermission = false;
    const projectAccess = await this.projectAccess.findByUserAndProject(
      user.id,
      project.id,
    );
    if (projectAccess) {
      const projectRolePermissions = await this.rolePermissions.listPermissionsForRole(
        projectAccess.roleId,
      );
      hasProjectPermission = projectRolePermissions.includes(permission);
    }

    if (!hasOrgPermission && !hasProjectPermission) {
      return {
        allowed: false,
        userId: user.id,
        permission,
        resource,
        organizationId: project.organizationId,
        deniedReason: 'missing-permission',
      };
    }

    // 4. The user MUST have explicit project_access OR an org-level role that
    //    includes the permission. For WORK-002 we require project_access for
    //    project-scoped actions (so a fresh org member does not automatically
    //    get every project). Org-level owners/admins still need project_access
    //    granted, EXCEPT they implicitly have access to all projects in their
    //    org (architecture §7 — org ownership implies project access). We
    //    implement this by allowing org-level `owner`/`admin` roles to satisfy
    //    project access when they hold the permission.
    const isOrgPrivileged = membership.roleId === 'owner' || membership.roleId === 'admin';
    if (projectAccess || (isOrgPrivileged && hasOrgPermission)) {
      return {
        allowed: true,
        userId: user.id,
        permission,
        resource,
        organizationId: project.organizationId,
      };
    }

    return {
      allowed: false,
      userId: user.id,
      permission,
      resource,
      organizationId: project.organizationId,
      deniedReason: 'no-project-access',
    };
  }

  async authorizeForOrganization(input: {
    user: User;
    permission: string;
    organizationId: string;
  }): Promise<OrganizationAuthorizationDecision> {
    const { user, permission, organizationId } = input;

    // 1. The user MUST be a member of the requested organization (AUTHZ-AC-02).
    //    This is the direct org-membership check — no synthetic project id.
    const membership = await this.memberships.findByUserAndOrganization(
      user.id,
      organizationId,
    );
    if (!membership) {
      return {
        allowed: false,
        userId: user.id,
        permission,
        organizationId,
        deniedReason: 'not-a-member',
      };
    }

    // 2. The user's role in this org MUST grant the permission.
    const permissionIds = await this.rolePermissions.listPermissionsForUserInOrganization(
      user.id,
      organizationId,
    );
    if (!permissionIds.includes(permission)) {
      return {
        allowed: false,
        userId: user.id,
        permission,
        organizationId,
        deniedReason: 'missing-permission',
      };
    }

    return {
      allowed: true,
      userId: user.id,
      permission,
      organizationId,
    };
  }

  /**
   * Authorize a MACHINE principal (a scoped service-account credential) for a
   * project resource. This is the SAME {@link AuthorizationService} — machine
   * principals ENTER the one authorization chain through the capability →
   * permission mapping (the machine analog of role → permission). There is no
   * parallel authorization mechanism (WORK-063 invariant #13).
   *
   * Decision chain for machines:
   *
   *   service account → org ownership of the project (tenant isolation,
   *                     AUTHZ-AC-02 for machines) → capability → permission
   *                     mapping → requested permission in the resolved set
   *
   * Fail closed: a capability not granted (or not in the credential's
   * effective scope) is denied with a typed denial (WORK-063 invariant #6).
   */
  async authorizeMachine(input: {
    serviceAccount: ServiceAccount;
    /** The effective capabilities of THIS credential (already intersected with the service account's set). */
    capabilities: readonly string[];
    permission: string;
    resource: ProtectedResource;
  }): Promise<AuthorizationDecision> {
    const { serviceAccount, capabilities, permission, resource } = input;
    if (resource.kind !== 'project') {
      return {
        allowed: false,
        userId: serviceAccount.id,
        permission,
        resource,
        organizationId: null,
        deniedReason: 'resource-not-found',
      };
    }
    if (!this.capabilityPermissions) {
      // No capability mapping configured → fail closed.
      return {
        allowed: false,
        userId: serviceAccount.id,
        permission,
        resource,
        organizationId: null,
        deniedReason: 'missing-permission',
      };
    }

    // 1. Resolve the resource's owning organization.
    const project = await this.projects.findById(resource.projectId);
    if (!project) {
      return {
        allowed: false,
        userId: serviceAccount.id,
        permission,
        resource,
        organizationId: null,
        deniedReason: 'resource-not-found',
      };
    }

    // 2. Tenant isolation for machines: the service account's org MUST own the
    //    project. A credential scoped to Org A cannot access Org B's project
    //    (AUTHZ-AC-02 — unchanged and unweakened for machines).
    if (project.organizationId !== serviceAccount.organizationId) {
      return {
        allowed: false,
        userId: serviceAccount.id,
        permission,
        resource,
        organizationId: project.organizationId,
        deniedReason: 'not-a-member',
      };
    }

    // 3. Capability → permission mapping (the SAME authorization path). The
    //    credential's effective capabilities map to a permission set; the
    //    requested permission must be in the resolved set (fail closed).
    const permissionIds = await this.capabilityPermissions.listPermissionsForCapabilities(
      capabilities,
    );
    if (!permissionIds.includes(permission)) {
      return {
        allowed: false,
        userId: serviceAccount.id,
        permission,
        resource,
        organizationId: project.organizationId,
        deniedReason: 'missing-permission',
      };
    }

    return {
      allowed: true,
      userId: serviceAccount.id,
      permission,
      resource,
      organizationId: project.organizationId,
    };
  }

  /**
   * Authorize a MACHINE principal for an organization-level operation. Same
   * capability → permission path as {@link authorizeMachine}, scoped to the
   * service account's own organization.
   */
  async authorizeMachineForOrganization(input: {
    serviceAccount: ServiceAccount;
    capabilities: readonly string[];
    permission: string;
    organizationId: string;
  }): Promise<OrganizationAuthorizationDecision> {
    const { serviceAccount, capabilities, permission, organizationId } = input;
    if (!this.capabilityPermissions) {
      return {
        allowed: false,
        userId: serviceAccount.id,
        permission,
        organizationId,
        deniedReason: 'missing-permission',
      };
    }
    // Tenant isolation: a machine principal may only act within its own org.
    if (organizationId !== serviceAccount.organizationId) {
      return {
        allowed: false,
        userId: serviceAccount.id,
        permission,
        organizationId,
        deniedReason: 'not-a-member',
      };
    }
    const permissionIds = await this.capabilityPermissions.listPermissionsForCapabilities(
      capabilities,
    );
    if (!permissionIds.includes(permission)) {
      return {
        allowed: false,
        userId: serviceAccount.id,
        permission,
        organizationId,
        deniedReason: 'missing-permission',
      };
    }
    return {
      allowed: true,
      userId: serviceAccount.id,
      permission,
      organizationId,
    };
  }
}

/**
 * Provision an API-key credential (AUTH-001).
 *
 * Stores ONLY the digest + an opaque SecretStore reference; the raw key is
 * placed in the SecretStore by the caller (or by the environment in dev).
 * This is the ONLY sanctioned way to create a credential row; raw keys never
 * touch domain records (SEC-AC-02).
 *
 * WORK-074: the input now optionally carries `serviceAccountId` + `scopes`
 * so a credential can be scoped to a machine principal (a service account)
 * with an explicit capability set. A human credential (the existing path)
 * leaves both unset/empty. API keys REMAIN first-class (WORK-063 invariant
 * #10) — this is an EXTENSION, never a removal.
 */
export interface ProvisionApiKeyInput {
  keyId: string;
  /** Opaque SecretStore reference (e.g. env var name). NOT the raw key. */
  secretRef: string;
  externalId: string;
  label: string;
  /** Raw key value, used only to compute the digest; never persisted. */
  rawKey: string;
  /**
   * Optional service account this credential authenticates. When set, the
   * credential is a MACHINE credential (authorization uses the capability →
   * permission mapping). When unset, the credential authenticates a human
   * external_id (the existing API-key path).
   */
  serviceAccountId?: string | null;
  /**
   * Explicit capability scopes for this credential. The credential's EFFECTIVE
   * capability set is the intersection of the service account's capabilities
   * and these scopes (fail closed). Empty for human credentials.
   */
  scopes?: readonly string[];
}

export interface ProvisionedApiKey {
  keyId: string;
  /** The opaque reference persisted; safe to log. */
  secretRef: string;
  externalId: string;
  label: string;
  serviceAccountId: string | null;
  scopes: readonly string[];
}

export class ApiKeyCredentialProvisioner {
  constructor(private readonly db: import('@platform/index.js').DatabaseClient) {}

  async provision(input: ProvisionApiKeyInput): Promise<ProvisionedApiKey> {
    const digest = sha256Hex(input.rawKey);
    const serviceAccountId = input.serviceAccountId ?? null;
    const scopes = input.scopes ? [...input.scopes] : [];
    await this.db.query(
      `INSERT INTO wfos_api_key_credentials (key_id, secret_ref, external_id, label, key_digest, service_account_id, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key_id) DO UPDATE
         SET secret_ref = EXCLUDED.secret_ref,
             external_id = EXCLUDED.external_id,
             label = EXCLUDED.label,
             key_digest = EXCLUDED.key_digest,
             service_account_id = EXCLUDED.service_account_id,
             scopes = EXCLUDED.scopes`,
      [input.keyId, input.secretRef, input.externalId, input.label, digest, serviceAccountId, scopes],
    );
    return {
      keyId: input.keyId,
      secretRef: input.secretRef,
      externalId: input.externalId,
      label: input.label,
      serviceAccountId,
      scopes,
    };
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

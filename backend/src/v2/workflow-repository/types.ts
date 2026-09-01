import type { DatabaseClient } from '@platform/postgres/database-client.js';

/**
 * V2-002 — Workflow Repository + Immutable Versioning public contracts.
 *
 * Object model (architecture constitution §2):
 *
 *   WorkflowRepository (the tenant-scoped repository surface)
 *     └── Workflow                 durable identity, repository/collaboration
 *          ├── immutable WorkflowVersion   content-addressed, append-only
 *          └── WorkflowInstallation        tenant install pinned to ONE version
 *
 * V2-002 owns repository identity, version immutability, ancestry, fork
 * identity, permissions/visibility and install pinning. It does NOT own
 * WorkflowIR semantics (V2-003), Node/Capability semantics (V2-004) or any
 * execution runtime (V2-005+) — the version `content` is an opaque semantic
 * document to this surface; only its canonical bytes and digest matter here.
 *
 * Protocol-visible identifiers (visibility values, digest rule) come from
 * V2-CTRL-003; V2-002-owned lifecycle vocabularies are declared here and are
 * not protocol-visible registry concepts.
 */

// ---------------------------------------------------------------------------
// Registry-governed vocabularies (V2-CTRL-003 — canonical, no aliases)
// ---------------------------------------------------------------------------

/** Canonical visibility identifiers (V2-CTRL-003 registry: `visibility`). */
export type WorkflowVisibility = 'private' | 'organization' | 'public';

// ---------------------------------------------------------------------------
// V2-002-owned lifecycle vocabularies
// ---------------------------------------------------------------------------

export type WorkflowLifecycleStatus = 'active' | 'archived';
export type WorkflowCollaboratorRole = 'owner' | 'writer' | 'reader';
export type WorkflowInstallationStatus = 'enabled' | 'disabled';

// ---------------------------------------------------------------------------
// V1-consumption ports (public contracts only — constitution §18)
// ---------------------------------------------------------------------------

/** A resolved tenant membership (from the V1 `/organizations` contract). */
export interface TenantMembership {
  readonly userId: string;
  readonly tenantId: string;
  readonly roleId: string;
}

/** Port: resolve a user's membership in a tenant (null when not a member). */
export interface TenantMembershipResolver {
  resolve(userId: string, tenantId: string): Promise<TenantMembership | null>;
}

/** Port: resolve user existence (from the V1 `/users` contract). */
export interface UserDirectory {
  findById(userId: string): Promise<{ id: string } | null>;
}

/** Dependencies for constructing the default repository service. */
export interface WorkflowRepositoryServiceDeps {
  /** The authoritative PostgreSQL application database. */
  database: DatabaseClient;
  /** Tenant (organization) membership resolution (V1 public contract). */
  membershipResolver: TenantMembershipResolver;
  /** User existence resolution (V1 public contract). */
  userDirectory: UserDirectory;
}

// ---------------------------------------------------------------------------
// Records (wire shapes returned by the service and the HTTP surface)
// ---------------------------------------------------------------------------

/** Fork provenance reference (exactly these two fields). */
export interface ForkProvenance {
  readonly workflowId: string;
  readonly workflowVersionId: string;
}

/** Version provenance (exactly these two fields). */
export interface WorkflowVersionProvenance {
  readonly origin: 'authored' | 'fork';
  readonly forkedFrom: ForkProvenance | null;
}

/** The durable Workflow identity record (repository scope). */
export interface WorkflowRecord {
  readonly workflowId: string;
  readonly ownerType: 'user';
  readonly ownerId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: WorkflowVisibility;
  readonly lifecycleStatus: WorkflowLifecycleStatus;
  readonly currentVersionId: string | null;
  readonly forkedFrom: ForkProvenance | null;
  readonly protocolVersion: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The immutable WorkflowVersion record (append-only, content-addressed). */
export interface WorkflowVersionRecord {
  readonly workflowVersionId: string;
  readonly workflowId: string;
  readonly contentDigest: string;
  /** Opaque semantic document (WorkflowIR is V2-003's surface). */
  readonly content: unknown;
  readonly parentVersionId: string | null;
  readonly protocolVersion: string;
  readonly provenance: WorkflowVersionProvenance;
  readonly message: string | null;
  readonly createdAt: string;
}

/** An explicit per-workflow collaborator grant. */
export interface WorkflowCollaboratorRecord {
  readonly userId: string;
  readonly role: WorkflowCollaboratorRole;
  readonly createdAt: string;
}

/** A tenant-scoped installation pinned to one immutable version. */
export interface WorkflowInstallationRecord {
  readonly installationId: string;
  readonly workflowId: string;
  readonly tenantId: string;
  readonly pinnedVersionId: string;
  readonly status: WorkflowInstallationStatus;
  readonly installedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The result of forking: a new workflow identity + its initial version. */
export interface ForkWorkflowResult {
  readonly workflow: WorkflowRecord;
  readonly initialVersion: WorkflowVersionRecord;
}

/**
 * The execution resolution contract consumed by a later executor (V2-005):
 * the installation resolves to its pinned immutable version. This is a
 * resolution path, NOT an execution engine (V2-002 owns no engine).
 */
export interface ExecutionTarget {
  readonly installation: WorkflowInstallationRecord;
  readonly version: WorkflowVersionRecord;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateWorkflowInput {
  readonly actorId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly visibility: WorkflowVisibility;
}

export interface UpdateWorkflowInput {
  readonly actorId: string;
  readonly workflowId: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly visibility?: WorkflowVisibility;
  readonly lifecycleStatus?: WorkflowLifecycleStatus;
}

export interface GrantCollaboratorInput {
  readonly actorId: string;
  readonly workflowId: string;
  readonly userId: string;
  readonly role: WorkflowCollaboratorRole;
}

export interface RevokeCollaboratorInput {
  readonly actorId: string;
  readonly workflowId: string;
  readonly userId: string;
}

export interface CommitWorkflowVersionInput {
  readonly actorId: string;
  readonly workflowId: string;
  /** Opaque semantic document; must be a JSON object. */
  readonly content: unknown;
  readonly message?: string | null;
  /**
   * Parent version. `undefined` = default to the workflow's current version;
   * `null` = explicit root (no parent). Same identity inputs converge.
   */
  readonly parentVersionId?: string | null;
  /** Defaults to the WorkflowOS 2.0 protocol version. */
  readonly protocolVersion?: string;
}

export interface ForkWorkflowInput {
  readonly actorId: string;
  readonly sourceWorkflowId: string;
  readonly tenantId: string;
  readonly name?: string;
  /** Defaults to `private` — forks never inherit source visibility. */
  readonly visibility?: WorkflowVisibility;
  /** Defaults to the source workflow's current version. */
  readonly sourceVersionId?: string;
}

export interface InstallWorkflowInput {
  readonly actorId: string;
  readonly workflowId: string;
  readonly tenantId: string;
  readonly workflowVersionId: string;
}

export interface UpdateWorkflowInstallationInput {
  readonly actorId: string;
  readonly installationId: string;
  /** Explicit customer-controlled re-pin (never silent). */
  readonly pinnedVersionId?: string;
  readonly status?: WorkflowInstallationStatus;
}

// ---------------------------------------------------------------------------
// The service contract
// ---------------------------------------------------------------------------

/**
 * The WorkflowOS 2.0 workflow repository service (V2-002's owned surface).
 *
 * Authorization model:
 * - read:   owner, explicit collaborator grant, `public` visibility, or
 *   `organization` visibility + tenant membership;
 * - write:  owner or `writer` grant (commits + repository metadata);
 * - manage: owner of record (visibility/lifecycle/collaborator grants);
 * - tenant actions (create/install/fork targets) additionally require
 *   membership of the target tenant;
 * - every denied read is `not-found` (no existence leak across scopes).
 */
export interface WorkflowRepositoryService {
  createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRecord>;
  getWorkflow(input: { actorId: string; workflowId: string }): Promise<WorkflowRecord>;
  updateWorkflow(input: UpdateWorkflowInput): Promise<WorkflowRecord>;

  listCollaborators(input: { actorId: string; workflowId: string }): Promise<WorkflowCollaboratorRecord[]>;
  grantCollaborator(input: GrantCollaboratorInput): Promise<WorkflowCollaboratorRecord>;
  revokeCollaborator(input: RevokeCollaboratorInput): Promise<void>;

  commitWorkflowVersion(input: CommitWorkflowVersionInput): Promise<WorkflowVersionRecord>;
  listVersions(input: { actorId: string; workflowId: string }): Promise<WorkflowVersionRecord[]>;
  getWorkflowVersion(input: {
    actorId: string;
    workflowId: string;
    workflowVersionId: string;
  }): Promise<WorkflowVersionRecord>;
  getWorkflowVersionByDigest(input: {
    actorId: string;
    workflowId: string;
    contentDigest: string;
  }): Promise<WorkflowVersionRecord>;
  getWorkflowVersionLineage(input: {
    actorId: string;
    workflowId: string;
    workflowVersionId: string;
  }): Promise<WorkflowVersionRecord[]>;

  forkWorkflow(input: ForkWorkflowInput): Promise<ForkWorkflowResult>;

  installWorkflow(input: InstallWorkflowInput): Promise<WorkflowInstallationRecord>;
  listWorkflowInstallations(input: {
    actorId: string;
    workflowId: string;
  }): Promise<WorkflowInstallationRecord[]>;
  getWorkflowInstallation(input: { actorId: string; installationId: string }): Promise<WorkflowInstallationRecord>;
  updateWorkflowInstallation(input: UpdateWorkflowInstallationInput): Promise<WorkflowInstallationRecord>;
  resolveExecutionTarget(input: { actorId: string; installationId: string }): Promise<ExecutionTarget>;
  uninstallWorkflow(input: { actorId: string; installationId: string }): Promise<void>;
}

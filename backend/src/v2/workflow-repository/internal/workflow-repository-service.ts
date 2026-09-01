import type { DatabaseClient, DatabaseTx } from '@platform/postgres/database-client.js';
import type {
  CommitWorkflowVersionInput,
  CreateWorkflowInput,
  ExecutionTarget,
  ForkWorkflowInput,
  ForkWorkflowResult,
  GrantCollaboratorInput,
  InstallWorkflowInput,
  RevokeCollaboratorInput,
  UpdateWorkflowInput,
  UpdateWorkflowInstallationInput,
  WorkflowCollaboratorRecord,
  WorkflowCollaboratorRole,
  WorkflowInstallationRecord,
  WorkflowInstallationStatus,
  WorkflowLifecycleStatus,
  WorkflowRecord,
  WorkflowRepositoryService,
  WorkflowRepositoryServiceDeps,
  WorkflowVersionRecord,
  WorkflowVersionProvenance,
  WorkflowVisibility,
} from '../types.js';
import {
  canonicalizeJson,
  computeContentDigest,
  deriveWorkflowVersionId,
  SUPPORTED_PROTOCOL_VERSIONS,
  V2_PROTOCOL_VERSION,
  WORKFLOW_COLLABORATOR_ROLES,
  WORKFLOW_INSTALLATION_STATUSES,
  WORKFLOW_LIFECYCLE_STATUSES,
  WORKFLOW_VISIBILITIES,
} from './canonical-json.js';
import {
  conflictError,
  forbiddenError,
  notFoundError,
  unsupportedProtocolError,
  validationError,
  WorkflowRepositoryError,
} from './errors.js';

/**
 * V2-002 — the default WorkflowRepositoryService.
 *
 * Persistence is hand-written parameterized SQL through the shared
 * `DatabaseClient` (the WorkflowOS convention — no ORM); PostgreSQL is the
 * sole authority for repository/version/fork/install state.
 *
 * Immutability is enforced at TWO levels:
 * 1. this service only ever INSERTs version rows (never UPDATE/DELETE); and
 * 2. a database trigger (migration 0060) rejects any direct UPDATE/DELETE on
 *    `wfos_v2_workflow_versions` — the negative proof the battery exercises.
 *
 * Determinism: version identity is derived only from the authoritative
 * identity inputs (workflowId, contentDigest, parentVersionId,
 * protocolVersion); duplicate delivery of the same identity inputs converges
 * on the same immutable row without moving the workflow's current pointer.
 * No wall-clock time or randomness participates in digests or identities.
 */

// ---------------------------------------------------------------------------
// Row shapes (snake_case database rows)
// ---------------------------------------------------------------------------

interface WorkflowRow {
  workflow_id: string;
  owner_type: string;
  owner_id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  visibility: string;
  lifecycle_status: string;
  current_version_id: string | null;
  forked_from_workflow_id: string | null;
  forked_from_version_id: string | null;
  protocol_version: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  workflow_version_id: string;
  workflow_id: string;
  content_digest: string;
  content: unknown;
  parent_version_id: string | null;
  protocol_version: string;
  provenance_origin: string;
  forked_from_workflow_id: string | null;
  forked_from_version_id: string | null;
  message: string | null;
  created_by: string;
  created_at: Date;
}

interface CollaboratorRow {
  workflow_id: string;
  user_id: string;
  role: string;
  granted_by: string | null;
  created_at: Date;
}

interface InstallationRow {
  installation_id: string;
  workflow_id: string;
  tenant_id: string;
  pinned_version_id: string;
  status: string;
  installed_by: string;
  created_at: Date;
  updated_at: Date;
}

const WORKFLOW_COLUMNS = `workflow_id, owner_type, owner_id, tenant_id, name, description,
  visibility, lifecycle_status, current_version_id, forked_from_workflow_id,
  forked_from_version_id, protocol_version, created_by, created_at, updated_at`;
const VERSION_COLUMNS = `workflow_version_id, workflow_id, content_digest, content,
  parent_version_id, protocol_version, provenance_origin, forked_from_workflow_id,
  forked_from_version_id, message, created_by, created_at`;
const INSTALLATION_COLUMNS = `installation_id, workflow_id, tenant_id, pinned_version_id,
  status, installed_by, created_at, updated_at`;

// ---------------------------------------------------------------------------
// Row → record mapping
// ---------------------------------------------------------------------------

function forkProvenanceFrom(
  workflowId: string | null,
  versionId: string | null,
): { workflowId: string; workflowVersionId: string } | null {
  if (workflowId === null || versionId === null) return null;
  return { workflowId, workflowVersionId: versionId };
}

function mapWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    workflowId: row.workflow_id,
    ownerType: 'user',
    ownerId: row.owner_id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    visibility: row.visibility as WorkflowVisibility,
    lifecycleStatus: row.lifecycle_status as WorkflowLifecycleStatus,
    currentVersionId: row.current_version_id,
    forkedFrom: forkProvenanceFrom(row.forked_from_workflow_id, row.forked_from_version_id),
    protocolVersion: row.protocol_version,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapVersion(row: VersionRow): WorkflowVersionRecord {
  const provenance: WorkflowVersionProvenance = {
    origin: row.provenance_origin as 'authored' | 'fork',
    forkedFrom: forkProvenanceFrom(row.forked_from_workflow_id, row.forked_from_version_id),
  };
  return {
    workflowVersionId: row.workflow_version_id,
    workflowId: row.workflow_id,
    contentDigest: row.content_digest,
    content: row.content,
    parentVersionId: row.parent_version_id,
    protocolVersion: row.protocol_version,
    provenance,
    message: row.message,
    createdAt: row.created_at.toISOString(),
  };
}

function mapCollaborator(row: CollaboratorRow): WorkflowCollaboratorRecord {
  return {
    userId: row.user_id,
    role: row.role as WorkflowCollaboratorRole,
    createdAt: row.created_at.toISOString(),
  };
}

function mapInstallation(row: InstallationRow): WorkflowInstallationRecord {
  return {
    installationId: row.installation_id,
    workflowId: row.workflow_id,
    tenantId: row.tenant_id,
    pinnedVersionId: row.pinned_version_id,
    status: row.status as WorkflowInstallationStatus,
    installedBy: row.installed_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireNonEmptyName(name: unknown, field: string): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw validationError(`${field} must be a non-empty string`);
  }
  return name.trim();
}

function requireVisibility(visibility: unknown): WorkflowVisibility {
  if (typeof visibility !== 'string' || !WORKFLOW_VISIBILITIES.includes(visibility)) {
    throw validationError(
      `visibility must be one of the canonical registry identifiers: ${WORKFLOW_VISIBILITIES.join(', ')}`,
    );
  }
  return visibility as WorkflowVisibility;
}

function requireLifecycleStatus(status: unknown): WorkflowLifecycleStatus {
  if (typeof status !== 'string' || !WORKFLOW_LIFECYCLE_STATUSES.includes(status)) {
    throw validationError(`lifecycleStatus must be one of: ${WORKFLOW_LIFECYCLE_STATUSES.join(', ')}`);
  }
  return status as WorkflowLifecycleStatus;
}

function requireCollaboratorRole(role: unknown): WorkflowCollaboratorRole {
  if (typeof role !== 'string' || !WORKFLOW_COLLABORATOR_ROLES.includes(role)) {
    throw validationError(`role must be one of: ${WORKFLOW_COLLABORATOR_ROLES.join(', ')}`);
  }
  return role as WorkflowCollaboratorRole;
}

function requireInstallationStatus(status: unknown): WorkflowInstallationStatus {
  if (typeof status !== 'string' || !WORKFLOW_INSTALLATION_STATUSES.includes(status)) {
    throw validationError(`status must be one of: ${WORKFLOW_INSTALLATION_STATUSES.join(', ')}`);
  }
  return status as WorkflowInstallationStatus;
}

/** Workflow documents are JSON objects (arrays/scalars are not documents). */
function requireObjectContent(content: unknown): Record<string, unknown> {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw validationError('workflow version content must be a JSON object');
  }
  return content as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class DefaultWorkflowRepositoryService implements WorkflowRepositoryService {
  private readonly db: DatabaseClient;
  private readonly deps: WorkflowRepositoryServiceDeps;

  constructor(deps: WorkflowRepositoryServiceDeps) {
    this.deps = deps;
    this.db = deps.database;
  }

  // --------------------------------------------------------- tenant checks

  private async requireTenantMember(userId: string, tenantId: string): Promise<void> {
    const membership = await this.deps.membershipResolver.resolve(userId, tenantId);
    if (!membership) {
      throw forbiddenError('actor is not a member of the target tenant');
    }
  }

  // -------------------------------------------------------- workflow reads

  private async findWorkflow(workflowId: string): Promise<WorkflowRow | null> {
    const res = await this.db.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM wfos_v2_workflows WHERE workflow_id = $1`,
      [workflowId],
    );
    return res.rows[0] ?? null;
  }

  private async getWorkflowRow(workflowId: string): Promise<WorkflowRow> {
    const row = await this.findWorkflow(workflowId);
    if (!row) throw notFoundError('workflow not found');
    return row;
  }

  private async getCollaboratorRole(
    workflowId: string,
    userId: string,
  ): Promise<WorkflowCollaboratorRole | null> {
    const res = await this.db.query<CollaboratorRow>(
      `SELECT workflow_id, user_id, role, granted_by, created_at
         FROM wfos_v2_workflow_collaborators
        WHERE workflow_id = $1 AND user_id = $2`,
      [workflowId, userId],
    );
    const row = res.rows[0];
    return row ? (row.role as WorkflowCollaboratorRole) : null;
  }

  /** Read access: owner, explicit grant, public, or organization+member. */
  private async canRead(wf: WorkflowRow, actorId: string): Promise<boolean> {
    if (wf.owner_id === actorId) return true;
    if (await this.getCollaboratorRole(wf.workflow_id, actorId)) return true;
    if (wf.visibility === 'public') return true;
    if (wf.visibility === 'organization') {
      const membership = await this.deps.membershipResolver.resolve(actorId, wf.tenant_id);
      return membership !== null;
    }
    return false;
  }

  /** Write access: owner or writer grant. */
  private async canWrite(wf: WorkflowRow, actorId: string): Promise<boolean> {
    if (wf.owner_id === actorId) return true;
    const role = await this.getCollaboratorRole(wf.workflow_id, actorId);
    return role === 'owner' || role === 'writer';
  }

  /** Manage access: the owner of record. */
  private async canManage(wf: WorkflowRow, actorId: string): Promise<boolean> {
    if (wf.owner_id === actorId) return true;
    const role = await this.getCollaboratorRole(wf.workflow_id, actorId);
    return role === 'owner';
  }

  /** Load a workflow and require read access (404 on denial — no leak). */
  private async getReadableWorkflow(workflowId: string, actorId: string): Promise<WorkflowRow> {
    const wf = await this.getWorkflowRow(workflowId);
    if (!(await this.canRead(wf, actorId))) {
      throw notFoundError('workflow not found');
    }
    return wf;
  }

  // ------------------------------------------------------------ workflows

  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRecord> {
    const name = requireNonEmptyName(input.name, 'name');
    const visibility = requireVisibility(input.visibility);
    const description =
      input.description === undefined || input.description === null
        ? null
        : String(input.description);
    await this.requireTenantMember(input.actorId, input.tenantId);

    return this.db.transaction(async (tx) => {
      const inserted = await tx.query<WorkflowRow>(
        `INSERT INTO wfos_v2_workflows
           (owner_type, owner_id, tenant_id, name, description, visibility,
            lifecycle_status, current_version_id, protocol_version, created_by)
         VALUES ('user', $1, $2, $3, $4, $5, 'active', NULL, $6, $1)
         RETURNING ${WORKFLOW_COLUMNS}`,
        [input.actorId, input.tenantId, name, description, visibility, V2_PROTOCOL_VERSION],
      );
      const row = inserted.rows[0]!;
      // The owner of record holds an explicit 'owner' grant from creation.
      await tx.query(
        `INSERT INTO wfos_v2_workflow_collaborators (workflow_id, user_id, role, granted_by)
         VALUES ($1, $2, 'owner', $2)
         ON CONFLICT (workflow_id, user_id) DO NOTHING`,
        [row.workflow_id, input.actorId],
      );
      return mapWorkflow(row);
    });
  }

  async getWorkflow(input: { actorId: string; workflowId: string }): Promise<WorkflowRecord> {
    const wf = await this.getReadableWorkflow(input.workflowId, input.actorId);
    return mapWorkflow(wf);
  }

  async updateWorkflow(input: UpdateWorkflowInput): Promise<WorkflowRecord> {
    const wf = await this.getWorkflowRow(input.workflowId);

    const wantsManage =
      input.visibility !== undefined || input.lifecycleStatus !== undefined;
    const allowed = wantsManage
      ? await this.canManage(wf, input.actorId)
      : await this.canWrite(wf, input.actorId);
    if (!allowed) {
      throw forbiddenError(
        wantsManage
          ? 'visibility and lifecycle changes require the manage permission'
          : 'workflow metadata changes require the write permission',
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.name !== undefined) add('name', requireNonEmptyName(input.name, 'name'));
    if (input.description !== undefined) {
      add('description', input.description === null ? null : String(input.description));
    }
    if (input.visibility !== undefined) add('visibility', requireVisibility(input.visibility));
    if (input.lifecycleStatus !== undefined) {
      add('lifecycle_status', requireLifecycleStatus(input.lifecycleStatus));
    }
    if (sets.length === 0) {
      throw validationError('nothing to update (name, description, visibility, lifecycleStatus)');
    }
    add('updated_at', new Date());

    const res = await this.db.query<WorkflowRow>(
      `UPDATE wfos_v2_workflows SET ${sets.join(', ')} WHERE workflow_id = $${params.length + 1}
       RETURNING ${WORKFLOW_COLUMNS}`,
      [...params, input.workflowId],
    );
    return mapWorkflow(res.rows[0]!);
  }

  // ------------------------------------------------------- collaborators

  async listCollaborators(input: {
    actorId: string;
    workflowId: string;
  }): Promise<WorkflowCollaboratorRecord[]> {
    await this.getReadableWorkflow(input.workflowId, input.actorId);
    const res = await this.db.query<CollaboratorRow>(
      `SELECT workflow_id, user_id, role, granted_by, created_at
         FROM wfos_v2_workflow_collaborators
        WHERE workflow_id = $1
        ORDER BY user_id ASC`,
      [input.workflowId],
    );
    return res.rows.map(mapCollaborator);
  }

  async grantCollaborator(input: GrantCollaboratorInput): Promise<WorkflowCollaboratorRecord> {
    const wf = await this.getWorkflowRow(input.workflowId);
    if (!(await this.canManage(wf, input.actorId))) {
      throw forbiddenError('granting collaborators requires the manage permission');
    }
    const role = requireCollaboratorRole(input.role);
    const target = await this.deps.userDirectory.findById(input.userId);
    if (!target) {
      throw validationError('unknown user');
    }

    const res = await this.db.query<CollaboratorRow>(
      `INSERT INTO wfos_v2_workflow_collaborators (workflow_id, user_id, role, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workflow_id, user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by
       RETURNING workflow_id, user_id, role, granted_by, created_at`,
      [input.workflowId, input.userId, role, input.actorId],
    );
    return mapCollaborator(res.rows[0]!);
  }

  async revokeCollaborator(input: RevokeCollaboratorInput): Promise<void> {
    const wf = await this.getWorkflowRow(input.workflowId);
    if (!(await this.canManage(wf, input.actorId))) {
      throw forbiddenError('revoking collaborators requires the manage permission');
    }
    if (input.userId === wf.owner_id) {
      throw conflictError('cannot revoke the owner of record');
    }
    const res = await this.db.query(
      `DELETE FROM wfos_v2_workflow_collaborators
        WHERE workflow_id = $1 AND user_id = $2`,
      [input.workflowId, input.userId],
    );
    if ((res.rowCount ?? 0) === 0) {
      throw notFoundError('collaborator not found');
    }
  }

  // ------------------------------------------------------------ versions

  private async findVersion(versionId: string): Promise<VersionRow | null> {
    const res = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM wfos_v2_workflow_versions WHERE workflow_version_id = $1`,
      [versionId],
    );
    return res.rows[0] ?? null;
  }

  async commitWorkflowVersion(input: CommitWorkflowVersionInput): Promise<WorkflowVersionRecord> {
    // Protocol compatibility is checked at the version boundary (fail closed).
    const protocolVersion =
      input.protocolVersion === undefined ? V2_PROTOCOL_VERSION : input.protocolVersion;
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      throw unsupportedProtocolError(
        `unsupported protocol version: ${JSON.stringify(protocolVersion)}`,
      );
    }
    const content = requireObjectContent(input.content);
    // Canonicalize BEFORE any persistence: non-JSON values fail closed here.
    let canonicalContent: string;
    try {
      canonicalContent = canonicalizeJson(content);
    } catch (err) {
      throw validationError(`workflow version content is not canonicalizable JSON: ${(err as Error).message}`);
    }
    const contentDigest = computeContentDigest(content);

    const wf = await this.getWorkflowRow(input.workflowId);
    if (!(await this.canWrite(wf, input.actorId))) {
      throw forbiddenError('committing versions requires the write permission');
    }
    if (wf.lifecycle_status === 'archived') {
      throw conflictError('cannot commit versions to an archived workflow');
    }

    // Parent resolution. `undefined` = default to the current version;
    // `null` = explicit root. Unknown parents 404; foreign parents 400.
    let parentVersionId: string | null;
    if (input.parentVersionId === undefined) {
      parentVersionId = wf.current_version_id;
    } else if (input.parentVersionId === null) {
      parentVersionId = null;
    } else {
      const parent = await this.findVersion(input.parentVersionId);
      if (!parent) throw notFoundError('parent version not found');
      if (parent.workflow_id !== input.workflowId) {
        throw validationError('parent version belongs to a different workflow');
      }
      parentVersionId = parent.workflow_version_id;
    }

    const workflowVersionId = deriveWorkflowVersionId({
      workflowId: input.workflowId,
      contentDigest,
      parentVersionId,
      protocolVersion,
    });
    const message = input.message === undefined || input.message === null ? null : String(input.message);

    return this.db.transaction(async (tx) => {
      // INSERT-only: a committed version is never mutated. Duplicate identity
      // inputs converge on the existing immutable row (deterministic).
      const inserted = await tx.query<VersionRow>(
        `INSERT INTO wfos_v2_workflow_versions
           (workflow_version_id, workflow_id, content_digest, content, parent_version_id,
            protocol_version, provenance_origin, forked_from_workflow_id,
            forked_from_version_id, message, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'authored', NULL, NULL, $7, $8)
         ON CONFLICT (workflow_version_id) DO NOTHING
         RETURNING ${VERSION_COLUMNS}`,
        [
          workflowVersionId,
          input.workflowId,
          contentDigest,
          canonicalContent,
          parentVersionId,
          protocolVersion,
          message,
          input.actorId,
        ],
      );
      const row = inserted.rows[0];
      if (row) {
        // A NEW immutable version: the workflow's current pointer follows the
        // newest commit (the old version remains unchanged).
        await tx.query(
          `UPDATE wfos_v2_workflows SET current_version_id = $1, updated_at = $2
            WHERE workflow_id = $3`,
          [workflowVersionId, new Date(), input.workflowId],
        );
        return mapVersion(row);
      }
      // Converged re-delivery: return the EXISTING immutable row and never
      // move the current pointer (duplicate delivery is idempotent).
      const existing = await tx.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM wfos_v2_workflow_versions WHERE workflow_version_id = $1`,
        [workflowVersionId],
      );
      return mapVersion(existing.rows[0]!);
    });
  }

  async listVersions(input: { actorId: string; workflowId: string }): Promise<WorkflowVersionRecord[]> {
    await this.getReadableWorkflow(input.workflowId, input.actorId);
    const res = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM wfos_v2_workflow_versions
        WHERE workflow_id = $1
        ORDER BY commit_seq ASC`,
      [input.workflowId],
    );
    return res.rows.map(mapVersion);
  }

  async getWorkflowVersion(input: {
    actorId: string;
    workflowId: string;
    workflowVersionId: string;
  }): Promise<WorkflowVersionRecord> {
    await this.getReadableWorkflow(input.workflowId, input.actorId);
    const res = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM wfos_v2_workflow_versions
        WHERE workflow_id = $1 AND workflow_version_id = $2`,
      [input.workflowId, input.workflowVersionId],
    );
    const row = res.rows[0];
    if (!row) throw notFoundError('workflow version not found');
    return mapVersion(row);
  }

  async getWorkflowVersionByDigest(input: {
    actorId: string;
    workflowId: string;
    contentDigest: string;
  }): Promise<WorkflowVersionRecord> {
    await this.getReadableWorkflow(input.workflowId, input.actorId);
    const res = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM wfos_v2_workflow_versions
        WHERE workflow_id = $1 AND content_digest = $2
        ORDER BY commit_seq ASC
        LIMIT 1`,
      [input.workflowId, input.contentDigest],
    );
    const row = res.rows[0];
    if (!row) throw notFoundError('workflow version not found');
    return mapVersion(row);
  }

  async getWorkflowVersionLineage(input: {
    actorId: string;
    workflowId: string;
    workflowVersionId: string;
  }): Promise<WorkflowVersionRecord[]> {
    await this.getReadableWorkflow(input.workflowId, input.actorId);
    const start = await this.getWorkflowVersion(input);
    const lineage: WorkflowVersionRecord[] = [start];
    // Walk parent → root (newest first). Parents always pre-exist their
    // children, so the chain is finite and acyclic; a hard bound guards
    // against any pathological state.
    const seen = new Set<string>([start.workflowVersionId]);
    let current = start;
    while (current.parentVersionId !== null) {
      if (seen.size > 100_000) {
        throw conflictError('version lineage exceeds the safety bound (cyclic ancestry?)');
      }
      const parent = await this.findVersion(current.parentVersionId);
      if (!parent) break; // parent rows are immutable and FK-guaranteed
      if (seen.has(parent.workflow_version_id)) {
        throw conflictError('version ancestry contains a cycle');
      }
      seen.add(parent.workflow_version_id);
      const mapped = mapVersion(parent);
      lineage.push(mapped);
      current = mapped;
    }
    return lineage;
  }

  // ---------------------------------------------------------------- forks

  async forkWorkflow(input: ForkWorkflowInput): Promise<ForkWorkflowResult> {
    // Forking requires READ access on the source (private sources do not
    // leak) and MEMBERSHIP of the target tenant (fail closed).
    const source = await this.getReadableWorkflow(input.sourceWorkflowId, input.actorId);
    await this.requireTenantMember(input.actorId, input.tenantId);

    const sourceVersionId =
      input.sourceVersionId === undefined ? source.current_version_id : input.sourceVersionId;
    if (!sourceVersionId) {
      throw notFoundError('cannot fork a workflow that has no versions');
    }
    const sourceVersion = await this.findVersion(sourceVersionId);
    if (!sourceVersion || sourceVersion.workflow_id !== source.workflow_id) {
      throw notFoundError('source version not found');
    }

    const visibility = requireVisibility(
      input.visibility === undefined ? 'private' : input.visibility,
    );
    const name = requireNonEmptyName(
      input.name === undefined ? source.name : input.name,
      'name',
    );

    // The fork's initial version preserves the source version's immutable
    // content byte-for-byte (canonical bytes + digest) under a NEW identity.
    const canonicalContent = canonicalizeJson(sourceVersion.content);
    const contentDigest = sourceVersion.content_digest;

    return this.db.transaction(async (tx) => {
      // 1. New durable workflow identity (a fork is NEVER a mutation of the
      //    source). Forks default to private visibility — never inherited.
      const insertedWorkflow = await tx.query<WorkflowRow>(
        `INSERT INTO wfos_v2_workflows
           (owner_type, owner_id, tenant_id, name, description, visibility,
            lifecycle_status, current_version_id, forked_from_workflow_id,
            forked_from_version_id, protocol_version, created_by)
         VALUES ('user', $1, $2, $3, $4, $5, 'active', NULL, $6, $7, $8, $1)
         RETURNING ${WORKFLOW_COLUMNS}`,
        [
          input.actorId,
          input.tenantId,
          name,
          source.description,
          visibility,
          source.workflow_id,
          sourceVersion.workflow_version_id,
          source.protocol_version,
        ],
      );
      const forkWorkflowRow = insertedWorkflow.rows[0]!;

      // 2. The fork's initial immutable version: same content digest, new
      //    identity (the workflowId identity input differs), no parent,
      //    provenance = fork with full source reference.
      const forkVersionId = deriveWorkflowVersionId({
        workflowId: forkWorkflowRow.workflow_id,
        contentDigest,
        parentVersionId: null,
        protocolVersion: source.protocol_version,
      });
      const insertedVersion = await tx.query<VersionRow>(
        `INSERT INTO wfos_v2_workflow_versions
           (workflow_version_id, workflow_id, content_digest, content, parent_version_id,
            protocol_version, provenance_origin, forked_from_workflow_id,
            forked_from_version_id, message, created_by)
         VALUES ($1, $2, $3, $4::jsonb, NULL, $5, 'fork', $6, $7, NULL, $8)
         ON CONFLICT (workflow_version_id) DO NOTHING
         RETURNING ${VERSION_COLUMNS}`,
        [
          forkVersionId,
          forkWorkflowRow.workflow_id,
          contentDigest,
          canonicalContent,
          source.protocol_version,
          source.workflow_id,
          sourceVersion.workflow_version_id,
          input.actorId,
        ],
      );
      let versionRow = insertedVersion.rows[0];
      if (!versionRow) {
        const existing = await tx.query<VersionRow>(
          `SELECT ${VERSION_COLUMNS} FROM wfos_v2_workflow_versions WHERE workflow_version_id = $1`,
          [forkVersionId],
        );
        versionRow = existing.rows[0]!;
      }

      // 3. The forker is the owner of record of the fork. Source
      //    collaborators/installations NEVER transfer (no private source
      //    state crosses the fork boundary).
      await tx.query(
        `INSERT INTO wfos_v2_workflow_collaborators (workflow_id, user_id, role, granted_by)
         VALUES ($1, $2, 'owner', $2)
         ON CONFLICT (workflow_id, user_id) DO NOTHING`,
        [forkWorkflowRow.workflow_id, input.actorId],
      );

      // 4. The fork's current pointer references the fork's own first version.
      const updatedWorkflow = await tx.query<WorkflowRow>(
        `UPDATE wfos_v2_workflows SET current_version_id = $1, updated_at = $2
          WHERE workflow_id = $3 RETURNING ${WORKFLOW_COLUMNS}`,
        [versionRow.workflow_version_id, new Date(), forkWorkflowRow.workflow_id],
      );
      return {
        workflow: mapWorkflow(updatedWorkflow.rows[0]!),
        initialVersion: mapVersion(versionRow),
      };
    });
  }

  // -------------------------------------------------------- installations

  private async findInstallation(installationId: string): Promise<InstallationRow | null> {
    const res = await this.db.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} FROM wfos_v2_workflow_installations WHERE installation_id = $1`,
      [installationId],
    );
    return res.rows[0] ?? null;
  }

  private async getTenantInstallation(
    installationId: string,
    actorId: string,
  ): Promise<InstallationRow> {
    const row = await this.findInstallation(installationId);
    if (!row) throw notFoundError('installation not found');
    // Installation access is tenant-scoped: 404 on denial (no leak).
    await this.requireTenantMemberOr404(actorId, row.tenant_id);
    return row;
  }

  private async requireTenantMemberOr404(userId: string, tenantId: string): Promise<void> {
    const membership = await this.deps.membershipResolver.resolve(userId, tenantId);
    if (!membership) {
      throw notFoundError('installation not found');
    }
  }

  async installWorkflow(input: InstallWorkflowInput): Promise<WorkflowInstallationRecord> {
    // Requires read access on the workflow (404 — no existence leak) AND
    // membership of the target tenant (403 — the action is the secret).
    const wf = await this.getReadableWorkflow(input.workflowId, input.actorId);
    await this.requireTenantMember(input.actorId, input.tenantId);

    const version = await this.findVersion(input.workflowVersionId);
    if (!version) throw notFoundError('workflow version not found');
    if (version.workflow_id !== wf.workflow_id) {
      throw validationError('workflow version belongs to a different workflow');
    }

    return this.db.transaction(async (tx) => {
      // One installation per (workflow, tenant): duplicate installs converge
      // on the same installation identity and NEVER silently re-pin.
      const inserted = await tx.query<InstallationRow>(
        `INSERT INTO wfos_v2_workflow_installations
           (workflow_id, tenant_id, pinned_version_id, status, installed_by)
         VALUES ($1, $2, $3, 'enabled', $4)
         ON CONFLICT (workflow_id, tenant_id) DO NOTHING
         RETURNING ${INSTALLATION_COLUMNS}`,
        [wf.workflow_id, input.tenantId, version.workflow_version_id, input.actorId],
      );
      const row = inserted.rows[0];
      if (row) return mapInstallation(row);
      const existing = await tx.query<InstallationRow>(
        `SELECT ${INSTALLATION_COLUMNS} FROM wfos_v2_workflow_installations
          WHERE workflow_id = $1 AND tenant_id = $2`,
        [wf.workflow_id, input.tenantId],
      );
      return mapInstallation(existing.rows[0]!);
    });
  }

  async listWorkflowInstallations(input: {
    actorId: string;
    workflowId: string;
  }): Promise<WorkflowInstallationRecord[]> {
    await this.getReadableWorkflow(input.workflowId, input.actorId);
    const res = await this.db.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} FROM wfos_v2_workflow_installations
        WHERE workflow_id = $1
        ORDER BY installation_id ASC`,
      [input.workflowId],
    );
    return res.rows.map(mapInstallation);
  }

  async getWorkflowInstallation(input: {
    actorId: string;
    installationId: string;
  }): Promise<WorkflowInstallationRecord> {
    const row = await this.getTenantInstallation(input.installationId, input.actorId);
    return mapInstallation(row);
  }

  async updateWorkflowInstallation(
    input: UpdateWorkflowInstallationInput,
  ): Promise<WorkflowInstallationRecord> {
    const row = await this.getTenantInstallation(input.installationId, input.actorId);

    if (input.pinnedVersionId !== undefined) {
      // Explicit customer-controlled re-pin; cross-workflow pins rejected.
      const version = await this.findVersion(input.pinnedVersionId);
      if (!version) throw notFoundError('workflow version not found');
      if (version.workflow_id !== row.workflow_id) {
        throw validationError('workflow version belongs to a different workflow');
      }
    }
    const status = input.status === undefined ? undefined : requireInstallationStatus(input.status);

    const res = await this.db.query<InstallationRow>(
      `UPDATE wfos_v2_workflow_installations
          SET pinned_version_id = COALESCE($1, pinned_version_id),
              status = COALESCE($2, status),
              updated_at = $3
        WHERE installation_id = $4
        RETURNING ${INSTALLATION_COLUMNS}`,
      [input.pinnedVersionId ?? null, status ?? null, new Date(), input.installationId],
    );
    return mapInstallation(res.rows[0]!);
  }

  async resolveExecutionTarget(input: {
    actorId: string;
    installationId: string;
  }): Promise<ExecutionTarget> {
    const row = await this.getTenantInstallation(input.installationId, input.actorId);
    // Execution fails closed while the installation is disabled.
    if (row.status !== 'enabled') {
      throw conflictError('installation is disabled');
    }
    const version = await this.findVersion(row.pinned_version_id);
    if (!version) {
      throw conflictError('pinned version is missing (integrity failure)');
    }
    return { installation: mapInstallation(row), version: mapVersion(version) };
  }

  async uninstallWorkflow(input: { actorId: string; installationId: string }): Promise<void> {
    const row = await this.getTenantInstallation(input.installationId, input.actorId);
    // Uninstall removes the INSTALLATION only — the pinned immutable version
    // remains addressable (historical versions are never mutated).
    await this.db.query(
      `DELETE FROM wfos_v2_workflow_installations WHERE installation_id = $1`,
      [row.installation_id],
    );
  }
}

/** Convenience factory matching the repo's service-creation convention. */
export function createWorkflowRepositoryService(
  deps: WorkflowRepositoryServiceDeps,
): WorkflowRepositoryService {
  return new DefaultWorkflowRepositoryService(deps);
}

export { WorkflowRepositoryError };
export type { DatabaseTx };

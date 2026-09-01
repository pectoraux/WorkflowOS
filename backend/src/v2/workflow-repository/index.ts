/**
 * WorkflowOS 2.0 — V2-002 Workflow Repository + Immutable Versioning.
 *
 * Public surface of the V2-002 work order (the Git-like durable repository
 * model): WorkflowRepository/Workflow identity, immutable WorkflowVersion
 * persistence with canonical content addressing, version ancestry, fork
 * identity/provenance, repository permissions/visibility, and
 * installation/version pinning.
 *
 * Scope boundaries (constitution + work order V2-002):
 * - WorkflowIR semantics/serialization/validation are V2-003's surface — the
 *   version `content` is an opaque semantic document here.
 * - Node/Capability/placement semantics are V2-004's surface.
 * - Workflow execution/runtime is V2-005+ — `resolveExecutionTarget` is the
 *   pinned-version resolution contract an executor consumes, not an engine.
 * - No marketplace economics, no teaching, no execution attestation here.
 *
 * Protocol-visible identifiers come only from V2-CTRL-003 (canonical
 * visibility identifiers, SHA-256/canonical-json digest rule); no aliases.
 * V1 functionality is consumed only through public module contracts (the
 * membership/user adapters below).
 */
export type {
  CreateWorkflowInput,
  ExecutionTarget,
  ForkProvenance,
  ForkWorkflowInput,
  ForkWorkflowResult,
  GrantCollaboratorInput,
  InstallWorkflowInput,
  RevokeCollaboratorInput,
  TenantMembership,
  TenantMembershipResolver,
  UpdateWorkflowInput,
  UpdateWorkflowInstallationInput,
  UserDirectory,
  WorkflowCollaboratorRecord,
  WorkflowCollaboratorRole,
  WorkflowInstallationRecord,
  WorkflowInstallationStatus,
  WorkflowLifecycleStatus,
  WorkflowRecord,
  WorkflowRepositoryService,
  WorkflowRepositoryServiceDeps,
  WorkflowVersionProvenance,
  WorkflowVersionRecord,
  WorkflowVisibility,
} from './types.js';

export {
  canonicalizeJson,
  computeContentDigest,
  deriveWorkflowVersionId,
  DIGEST_ALGORITHM,
  SUPPORTED_PROTOCOL_VERSIONS,
  V2_PROTOCOL_VERSION,
  WORKFLOW_VISIBILITIES,
  type WorkflowVersionIdentityInputs,
} from './internal/canonical-json.js';

export { WorkflowRepositoryError, type WorkflowRepositoryErrorCode } from './internal/errors.js';

export { createWorkflowRepositoryService, DefaultWorkflowRepositoryService } from './internal/workflow-repository-service.js';
export { membershipRepositoryAdapter, userDirectoryAdapter } from './internal/adapters.js';
export { v2WorkflowRepositoryRoutes, type V2WorkflowRepositoryRouteDeps } from './routes.js';

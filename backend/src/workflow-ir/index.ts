/**
 * V2-003 — WorkflowIR public barrel.
 *
 * WorkflowIR is the canonical, platform-neutral semantic representation of a
 * WorkflowVersion and the sole semantic source of truth for WorkflowOS
 * workflows (architecture constitution §2/§3).
 *
 * This domain owns the IR schema, canonical serialization, structural and
 * semantic validation, compatibility/version rules and the semantic digest.
 * It is a pure semantic authority:
 * - no repository/version persistence (V2-002 owns that);
 * - no Node/Capability advertisement or placement resolution (V2-004);
 * - no execution runtime, teaching, compiler or marketplace semantics
 *   (V2-005/V2-008, V2-006, V2-007, V2-012);
 * - protocol-visible identifiers come only from V2-CTRL-003.
 *
 * The runtime surface below is pinned by
 * tests/workflow-ir/ir-boundary.test.ts (no lifecycle functions — WorkflowIR
 * is not a second workflow engine, repository or authorization authority).
 */

// ---- schema / vocabularies (pinned to V2-CTRL-003) -----------------------
export {
  WORKFLOW_IR_SCHEMA_VERSION,
  SUPPORTED_WORKFLOW_IR_SCHEMA_VERSIONS,
  WORKFLOW_IR_EXECUTION_CLASSES,
  WORKFLOW_IR_PLACEMENT_IDS,
  WORKFLOW_IR_VALUE_TYPE_TAGS,
  WORKFLOW_IR_DIGEST_ALGORITHM,
  WORKFLOW_IR_CANONICAL_CAPABILITIES,
  WORKFLOW_IR_CAPABILITY_ALIASES,
} from './types.js';

// ---- errors ---------------------------------------------------------------
export { WorkflowIRError, WORKFLOW_IR_ERROR_REASONS } from './internal/errors.js';

// ---- validation / canonicalization ---------------------------------------
export { validateWorkflowIR } from './internal/validate.js';

// ---- serialization / digest / equivalence ---------------------------------
export {
  serializeWorkflowIR,
  deserializeWorkflowIR,
  computeWorkflowIRDigest,
  workflowIRsAreSemanticallyEqual,
} from './internal/serialize.js';

// ---- canonical JSON (the registry digest rule's serialization form) -------
export { canonicalJsonString } from './internal/canonical-json.js';

// ---- compatibility / version negotiation ----------------------------------
export { negotiateWorkflowIRSchemaVersion } from './internal/version.js';

// ---- types -----------------------------------------------------------------
export type {
  WorkflowIR,
  DeepMutableWorkflowIR,
  WorkflowIRNode,
  WorkflowIRStepNode,
  WorkflowIRDecisionNode,
  WorkflowIRStartNode,
  WorkflowIREndNode,
  WorkflowIREdge,
  WorkflowIREdgeKind,
  WorkflowIRDataBinding,
  WorkflowIRBindingSource,
  WorkflowIRBindingTarget,
  WorkflowIRPort,
  WorkflowIRValueType,
  WorkflowIRValueTypeTag,
  WorkflowIRLiteral,
  WorkflowIRLiteralType,
  WorkflowIRDependency,
  WorkflowIRRequirements,
  WorkflowIRPlacement,
  WorkflowIRProvenance,
  WorkflowIRProvenanceOrigin,
  WorkflowIRCondition,
  WorkflowIRDecisionCase,
  WorkflowIRFailurePolicy,
  WorkflowIRExecutionClass,
  WorkflowIRPlacementId,
  WorkflowIRValidationOptions,
  WorkflowIRVersionNegotiation,
} from './types.js';
export type { WorkflowIRErrorReason } from './internal/errors.js';

/**
 * V2-004 — Node + Capability Protocol: public surface.
 *
 * Work Order V2-004 (W1, parallel-no-rebase; base ed82bbc) — owns Node
 * identity, capability advertisement/versioning, capability requirement
 * matching, placement/locality/privacy constraints, node trust/health
 * attributes and cross-host conformance fixtures.
 *
 * Core architectural rule (architecture-constitution §5):
 * a Node advertises capability; capability does not grant authorization.
 *
 *   eligibility = capability availability
 *                 AND workflow policy
 *                 AND user/organization authorization
 *                 AND placement constraints
 *                 AND node trust/health
 *
 * Change-surface discipline: this tree is self-contained (no V1 module
 * imports, no sibling V2-002/V2-003 surfaces — those are consumed only as
 * merged contracts by later integration gates). Protocol-visible identifiers
 * come exclusively from the frozen V2 protocol registry (V2-CTRL-003); no
 * aliases are introduced.
 */
export * from './types.js';
export {
  ASSURANCE_STRENGTH_ORDER,
  CANONICAL_ASSURANCE_LEVELS,
  CANONICAL_CAPABILITY_NAMES,
  CANONICAL_EVENT_NAMES,
  CANONICAL_EXECUTION_CLASSES,
  CANONICAL_PLACEMENT_CONSTRAINTS,
  CURRENT_PROTOCOL_VERSION,
  PROTOCOL_REGISTRY_SOURCE,
  REGISTRY_AUTHORITY_RULES,
  assuranceStrength,
  isCanonicalAssuranceLevel,
  isCanonicalCapabilityName,
  isCanonicalEventName,
  isCanonicalExecutionClass,
  isCanonicalPlacementConstraint,
  negotiateProtocolVersion,
} from './internal/canonical-registry.js';
export {
  canonicalJsonStringify,
} from './internal/canonical-json.js';
export {
  computeNodeId,
  createNodeKeyDirectory,
  deriveNodeKeyFingerprint,
  signRegistrationPayload,
} from './internal/node-identity.js';
export { createNodeCapabilityService } from './internal/node-capability-service.js';
export {
  CANONICAL_WORKFLOW_FIXTURE,
  EXPECTED_HOST_ELIGIBILITY_MATRIX,
  HOST_CLASS_CONFORMANCE_FIXTURES,
} from './internal/conformance-fixtures.js';

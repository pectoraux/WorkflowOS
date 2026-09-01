/**
 * V2-004 — Node + Capability Protocol: public type contracts.
 *
 * Work Order V2-004 (base ed82bbc): owns Node identity, capability
 * advertisement/versioning, capability requirement matching,
 * placement/locality/privacy constraints, node trust/health attributes and
 * cross-host conformance fixtures.
 *
 * Core architectural rule (architecture-constitution §5, V2-CTRL-003
 * authorityRules `capability-advertisement-is-not-authorization`):
 *
 *   eligibility = capability availability
 *                 AND workflow policy
 *                 AND user/organization authorization
 *                 AND placement constraints
 *                 AND node trust/health
 *
 * A node must never silently emulate, substitute or claim a capability it
 * does not actually have. Every dimension above is evaluated separately and
 * reported explicitly; none may substitute for another.
 *
 * Protocol-visible identifiers (capability names, execution classes,
 * placement constraints, assurance levels, event names) come ONLY from the
 * frozen V2 protocol registry (V2-CTRL-003). No aliases are introduced.
 */

/** Host platform classes the universal protocol runs on (constitution §4). */
export type HostPlatformClass = 'web' | 'desktop' | 'ios' | 'android' | 'cloud';

/** Canonical execution classes (V2-CTRL-003 executionClasses). */
export type ExecutionClass =
  | 'deterministic_api'
  | 'agentic_computer_use'
  | 'human'
  | 'subworkflow';

/** Canonical placement/locality constraints (V2-CTRL-003 placement). */
export type PlacementConstraint =
  | 'device_local'
  | 'device_preferred'
  | 'cloud_allowed'
  | 'cloud_preferred'
  | 'cloud_required'
  | 'any_supported_node';

/** Canonical execution assurance identifiers (V2-CTRL-003 assurance). */
export type AssuranceLevel =
  | 'software_signed'
  | 'hardware_backed'
  | 'tee_attested'
  | 'verifiable_computation';

/** Capability health — an explicit availability dimension. */
export type CapabilityHealth = 'healthy' | 'degraded' | 'unavailable';

/** Node trust level — explicit, never inferred from capability possession. */
export type TrustLevel = 'unverified' | 'verified' | 'trusted';

/** Honest cloud-egress declaration of a node's privacy posture. */
export type CloudEgressPosture = 'none' | 'allowed';

/**
 * Secret delivery posture. The protocol accepts exactly one honest value:
 * secrets are referenced opaquely and delivered only through authorized
 * runtime paths (constitution §16).
 */
export type SecretDeliveryPosture = 'opaque_reference_only';

/** Workflow-level data locality constraints (privacy policy dimension). */
export type DataLocality = 'device_only' | 'device_or_cloud';

/**
 * Trust attributes attached to a capability advertisement. `assurance` is
 * `null` when a host lacks stronger assurance — absence is reported
 * explicitly, never silently downgraded or emulated (constitution §21).
 */
export interface TrustAttributes {
  trustLevel: TrustLevel;
  assurance: AssuranceLevel | null;
}

/** One advertised capability with its version, classes, health and trust. */
export interface CapabilityAdvertisement {
  /** Registry-canonical capability name (e.g. `filesystem.read`). */
  capability: string;
  /** Monotonic per-(node, capability) advertisement version. */
  capabilityVersion: number;
  /** Execution classes this node honestly supports for the capability. */
  executionClasses: ExecutionClass[];
  health: CapabilityHealth;
  trust: TrustAttributes;
}

/** A node's honest privacy posture. */
export interface NodePrivacyPosture {
  /** Whether the host can surface a human-approval interaction. */
  supportsHumanApproval: boolean;
  /** Whether node-local data may egress to cloud infrastructure. */
  cloudEgress: CloudEgressPosture;
  secretDelivery: SecretDeliveryPosture;
}

/** HMAC-SHA256 registration authentication (out-of-band host key material). */
export interface RegistrationAuth {
  algorithm: 'hmac-sha256';
  digest: string;
}

/** The authoritative identity inputs a node id is derived from. */
export interface NodeIdentityInputs {
  keyFingerprint: string;
  ownerPrincipal: string;
  platformClass: HostPlatformClass;
}

/** An authenticated node registration request. */
export interface NodeRegistrationRequest {
  nodeKeyFingerprint: string;
  platformClass: HostPlatformClass;
  ownerPrincipal: string;
  protocolVersion: string;
  /** Monotonic per-node registration sequence (replays are stale). */
  registrationSequence: number;
  advertisements: CapabilityAdvertisement[];
  privacyPosture: NodePrivacyPosture;
  auth: RegistrationAuth;
}

/** Discoverable node state (never contains host key material). */
export interface NodeDescriptor {
  nodeId: string;
  keyFingerprint: string;
  platformClass: HostPlatformClass;
  ownerPrincipal: string;
  protocolVersion: string;
  registrationSequence: number;
  /** Advertisements in deterministic (registry-name sorted) order. */
  capabilities: CapabilityAdvertisement[];
  privacyPosture: NodePrivacyPosture;
}

/** Workflow-level privacy constraints attached to a step requirement. */
export interface PrivacyConstraints {
  dataLocality: DataLocality;
  requiresHumanApproval: boolean;
}

/** One workflow step's capability requirement (platform-neutral). */
export interface StepCapabilityRequirement {
  stepId: string;
  /** Registry-canonical capability name. */
  capability: string;
  executionClass: ExecutionClass;
  /**
   * Execution classes the workflow EXPLICITLY declares as acceptable
   * fallbacks. Undeclared substitution never happens (constitution §6).
   */
  fallbackExecutionClasses?: ExecutionClass[];
  placement: PlacementConstraint;
  privacy: PrivacyConstraints;
  /** Minimum assurance the step requires (absence is below any floor). */
  assuranceFloor?: AssuranceLevel;
}

/** A workflow's node-eligibility request (WorkflowIR-facing contract). */
export interface WorkflowExecutionRequest {
  workflowVersionRef: string;
  steps: StepCapabilityRequirement[];
}

/**
 * An explicit authorization decision. Authorization is an EXTERNAL authority
 * dimension (user/organization authorization): a node never grants it and
 * capability possession never implies it. `subject` binds the decision to the
 * workflow version (evaluation) or capability (invocation) it authorizes.
 */
export interface AuthorizationDecision {
  principal: string;
  status: 'authorized' | 'denied';
  subject: string;
}

/** Placement tier a node offers for a step's placement constraint. */
export type PlacementTier = 'exact' | 'preferred' | 'fallback' | 'neutral';

/** Canonical per-step eligibility reason codes (fixed report order). */
export type EligibilityReason =
  | 'capability_missing'
  | 'capability_unhealthy'
  | 'execution_class_unsupported'
  | 'trust_unverified'
  | 'assurance_below_floor'
  | 'placement_forbidden'
  | 'privacy_data_locality'
  | 'privacy_human_approval_unsupported'
  | 'authorization_scope_mismatch'
  | 'authorization_missing'
  | 'authorization_denied';

/** Per-step eligibility decision. */
export interface StepEligibilityDecision {
  stepId: string;
  capability: string;
  eligible: boolean;
  /** Failed dimensions in the canonical reason order (empty when eligible). */
  reasons: EligibilityReason[];
  /** The advertisement matched for this step, or null when unsupported. */
  advertised: CapabilityAdvertisement | null;
  /** Resolved execution class (null when the class dimension failed). */
  resolvedExecutionClass: ExecutionClass | null;
  /** True only when a workflow-DECLARED fallback class was used. */
  viaDeclaredFallback: boolean;
  /** Placement tier offered, or null when placement is forbidden. */
  placementTier: PlacementTier | null;
}

/** Whole-workflow eligibility evaluation against one node. */
export interface WorkflowEligibilityEvaluation {
  nodeId: string;
  workflowVersionRef: string;
  workflowEligible: boolean;
  steps: StepEligibilityDecision[];
}

/** One capability invocation request at the execution boundary. */
export interface CapabilityInvocationRequest {
  stepId: string;
  capability: string;
  executionClass: ExecutionClass;
  /** Invocation input; inline secret material is rejected (§16). */
  input: unknown;
  authorization: AuthorizationDecision | null;
}

/** Evidence record of one completed capability invocation. */
export interface CapabilityInvocationRecord {
  nodeId: string;
  stepId: string;
  capability: string;
  executionClass: ExecutionClass;
  /** Deterministic monotonic per-node invocation sequence (from 1). */
  invocationSequence: number;
  event: 'capability.invocation.completed';
  evidenceClass: 'observation';
  input: unknown;
  output: unknown;
}

/** Host-side capability execution handler (the platform adapter seam). */
export type HostCapabilityHandler = (input: unknown) => unknown;

/** Out-of-band host key material directory entry. */
export interface NodeKeyDirectoryEntry {
  keyFingerprint: string;
  secret: string;
}

/** Resolves host key material out-of-band; never serialized into payloads. */
export interface NodeKeyDirectory {
  resolve(keyFingerprint: string): string | null;
}

export interface NodeCapabilityServiceOptions {
  keyDirectory: NodeKeyDirectory;
}

/** The Node + Capability protocol service surface. */
export interface NodeCapabilityService {
  /** Authenticated registration (fail closed; no partial state on error). */
  registerNode(request: NodeRegistrationRequest): NodeDescriptor;
  /** All registered node descriptors in deterministic nodeId order. */
  discoverNodes(): NodeDescriptor[];
  /** Evaluate the five eligibility dimensions for a workflow on one node. */
  evaluateNode(
    nodeId: string,
    request: WorkflowExecutionRequest,
    authorization: AuthorizationDecision | null,
  ): WorkflowEligibilityEvaluation;
  /** Attach a host execution handler for one (capability, execution class). */
  attachHostHandler(
    nodeId: string,
    capability: string,
    executionClass: ExecutionClass,
    handler: HostCapabilityHandler,
  ): void;
  /** Invoke a capability through the full authorization/matching gate. */
  invokeCapability(nodeId: string, request: CapabilityInvocationRequest): CapabilityInvocationRecord;
}

/** Machine-readable protocol error codes. */
export type ProtocolErrorCode =
  | 'unknown_node_key'
  | 'node_authentication_failed'
  | 'protocol_version_mismatch'
  | 'invalid_registration'
  | 'invalid_capability_name'
  | 'invalid_execution_class'
  | 'invalid_placement_constraint'
  | 'invalid_assurance_level'
  | 'invalid_privacy_posture'
  | 'invalid_privacy_constraint'
  | 'invalid_authorization_decision'
  | 'invalid_workflow_request'
  | 'invalid_invocation_request'
  | 'stale_registration'
  | 'stale_capability_advertisement'
  | 'capability_advertisement_conflict'
  | 'node_unknown'
  | 'authorization_required'
  | 'authorization_denied'
  | 'authorization_scope_mismatch'
  | 'capability_missing'
  | 'execution_class_unsupported'
  | 'capability_unhealthy'
  | 'trust_unverified'
  | 'opaque_secret_reference_required'
  | 'capability_execution_unavailable'
  | 'capability_execution_failed';

/** Typed protocol error: the code is machine-readable and stable. */
export class NodeCapabilityProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'NodeCapabilityProtocolError';
    this.code = code;
  }
}

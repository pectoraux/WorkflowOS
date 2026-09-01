/**
 * V2-004 — The Node + Capability protocol service.
 *
 * Implements the host-side capability and placement contract: authenticated
 * node identity, capability advertisement/versioning, capability requirement
 * matching separated from authorization, placement/locality/privacy
 * constraints, node trust/health dimensions, and the invocation gate.
 *
 * The eligibility conjunction (constitution §5) is evaluated as five
 * SEPARATE dimensions, each reported with its own canonical reason:
 *
 *   capability availability AND workflow policy (placement/privacy)
 *   AND user/organization authorization AND node trust/health
 *
 * A node never silently emulates, substitutes or claims a capability it does
 * not have; a missing capability is an explicit ineligible result; fallback
 * execution classes apply only when the workflow DECLARED them; unhealthy,
 * untrusted, assurance-below-floor and unauthorized conditions fail closed.
 */
import {
  NodeCapabilityProtocolError,
  type AuthorizationDecision,
  type CapabilityAdvertisement,
  type CapabilityInvocationRecord,
  type CapabilityInvocationRequest,
  type EligibilityReason,
  type ExecutionClass,
  type HostCapabilityHandler,
  type HostPlatformClass,
  type NodeDescriptor,
  type NodePrivacyPosture,
  type NodeRegistrationRequest,
  type NodeCapabilityService,
  type NodeCapabilityServiceOptions,
  type PlacementConstraint,
  type PlacementTier,
  type StepCapabilityRequirement,
  type StepEligibilityDecision,
  type WorkflowEligibilityEvaluation,
  type WorkflowExecutionRequest,
} from '../types.js';
import { canonicalJsonStringify, digestsEqual } from './canonical-json.js';
import {
  CURRENT_PROTOCOL_VERSION,
  assuranceStrength,
  isCanonicalAssuranceLevel,
  isCanonicalCapabilityName,
  isCanonicalExecutionClass,
  isCanonicalPlacementConstraint,
  negotiateProtocolVersion,
} from './canonical-registry.js';
import { computeNodeId, signRegistrationPayload } from './node-identity.js';

const HOST_PLATFORM_CLASSES: readonly HostPlatformClass[] = [
  'web',
  'desktop',
  'ios',
  'android',
  'cloud',
];

const CAPABILITY_HEALTH_STATES = new Set<string>(['healthy', 'degraded', 'unavailable']);
const TRUST_LEVELS = new Set<string>(['unverified', 'verified', 'trusted']);
const DATA_LOCALITIES = new Set<string>(['device_only', 'device_or_cloud']);
const AUTHORIZATION_STATUSES = new Set<string>(['authorized', 'denied']);

/** Keys whose values are secret material unless referenced opaquely. */
const SECRET_KEY_PATTERN = /(password|secret|token|api[-_]?key|private[-_]?key|credential)/i;
const OPAQUE_SECRET_REFERENCE_PREFIX = 'secretref:';

interface NodeRecord {
  nodeId: string;
  keyFingerprint: string;
  ownerPrincipal: string;
  platformClass: HostPlatformClass;
  protocolVersion: string;
  registrationSequence: number;
  privacyPosture: NodePrivacyPosture;
  /** Current advertised capabilities by canonical capability name. */
  capabilities: Map<string, CapabilityAdvertisement>;
  invocationSequence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function cloneAdvertisement(advertisement: CapabilityAdvertisement): CapabilityAdvertisement {
  return {
    capability: advertisement.capability,
    capabilityVersion: advertisement.capabilityVersion,
    executionClasses: [...advertisement.executionClasses],
    health: advertisement.health,
    trust: { ...advertisement.trust },
  };
}

function clonePrivacyPosture(posture: NodePrivacyPosture): NodePrivacyPosture {
  return { ...posture };
}

function descriptorOf(record: NodeRecord): NodeDescriptor {
  const capabilities = [...record.capabilities.values()]
    .map(cloneAdvertisement)
    .sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0));
  return {
    nodeId: record.nodeId,
    keyFingerprint: record.keyFingerprint,
    platformClass: record.platformClass,
    ownerPrincipal: record.ownerPrincipal,
    protocolVersion: record.protocolVersion,
    registrationSequence: record.registrationSequence,
    capabilities,
    privacyPosture: clonePrivacyPosture(record.privacyPosture),
  };
}

function handlerKey(capability: string, executionClass: string): string {
  return `${capability}|${executionClass}`;
}

/** Throws unless the value is a well-formed advertisement (fail closed). */
function validateAdvertisement(value: unknown): CapabilityAdvertisement {
  if (!isRecord(value)) {
    throw new NodeCapabilityProtocolError('invalid_registration', 'advertisement is not an object');
  }
  const capability = value['capability'];
  if (!isNonEmptyString(capability) || !isCanonicalCapabilityName(capability)) {
    throw new NodeCapabilityProtocolError(
      'invalid_capability_name',
      `non-canonical capability name: ${String(capability)}`,
    );
  }
  const capabilityVersion = value['capabilityVersion'];
  if (typeof capabilityVersion !== 'number' || !Number.isInteger(capabilityVersion) || capabilityVersion < 1) {
    throw new NodeCapabilityProtocolError(
      'invalid_registration',
      `capability ${capability}: capabilityVersion must be a positive integer`,
    );
  }
  const executionClasses = value['executionClasses'];
  if (!Array.isArray(executionClasses) || executionClasses.length === 0) {
    throw new NodeCapabilityProtocolError(
      'invalid_registration',
      `capability ${capability}: executionClasses must be a non-empty array`,
    );
  }
  for (const executionClass of executionClasses) {
    if (typeof executionClass !== 'string' || !isCanonicalExecutionClass(executionClass)) {
      throw new NodeCapabilityProtocolError(
        'invalid_execution_class',
        `capability ${capability}: non-canonical execution class ${String(executionClass)}`,
      );
    }
  }
  const health = value['health'];
  if (typeof health !== 'string' || !CAPABILITY_HEALTH_STATES.has(health)) {
    throw new NodeCapabilityProtocolError(
      'invalid_registration',
      `capability ${capability}: invalid health state ${String(health)}`,
    );
  }
  const trust = value['trust'];
  if (!isRecord(trust)) {
    throw new NodeCapabilityProtocolError(
      'invalid_registration',
      `capability ${capability}: trust attributes are required`,
    );
  }
  const trustLevel = trust['trustLevel'];
  if (typeof trustLevel !== 'string' || !TRUST_LEVELS.has(trustLevel)) {
    throw new NodeCapabilityProtocolError(
      'invalid_registration',
      `capability ${capability}: invalid trust level ${String(trustLevel)}`,
    );
  }
  const assurance = trust['assurance'];
  let assuranceLevel: CapabilityAdvertisement['trust']['assurance'] = null;
  if (assurance === null || assurance === undefined) {
    // Explicit absence of stronger assurance — honestly reported, never
    // faked (constitution §21).
    assuranceLevel = null;
  } else if (typeof assurance === 'string' && isCanonicalAssuranceLevel(assurance)) {
    assuranceLevel = assurance as CapabilityAdvertisement['trust']['assurance'];
  } else {
    throw new NodeCapabilityProtocolError(
      'invalid_assurance_level',
      `capability ${capability}: non-canonical assurance level ${String(assurance)}`,
    );
  }
  return {
    capability,
    capabilityVersion,
    executionClasses: [...executionClasses] as ExecutionClass[],
    health: health as CapabilityAdvertisement['health'],
    trust: {
      trustLevel: trustLevel as CapabilityAdvertisement['trust']['trustLevel'],
      assurance: assuranceLevel,
    },
  };
}

/** Throws unless the posture is honest for the platform class. */
function validatePrivacyPosture(value: unknown, platformClass: HostPlatformClass): NodePrivacyPosture {
  if (!isRecord(value)) {
    throw new NodeCapabilityProtocolError('invalid_privacy_posture', 'privacyPosture is not an object');
  }
  const supportsHumanApproval = value['supportsHumanApproval'];
  if (typeof supportsHumanApproval !== 'boolean') {
    throw new NodeCapabilityProtocolError(
      'invalid_privacy_posture',
      'privacyPosture.supportsHumanApproval must be boolean',
    );
  }
  const cloudEgress = value['cloudEgress'];
  if (cloudEgress !== 'none' && cloudEgress !== 'allowed') {
    throw new NodeCapabilityProtocolError(
      'invalid_privacy_posture',
      `privacyPosture.cloudEgress must be 'none' or 'allowed' (got ${String(cloudEgress)})`,
    );
  }
  const secretDelivery = value['secretDelivery'];
  if (secretDelivery !== 'opaque_reference_only') {
    throw new NodeCapabilityProtocolError(
      'invalid_privacy_posture',
      `privacyPosture.secretDelivery must be 'opaque_reference_only' (got ${String(secretDelivery)})`,
    );
  }
  if (platformClass === 'cloud' && cloudEgress !== 'allowed') {
    // A cloud host claiming zero cloud egress is untruthful, not private.
    throw new NodeCapabilityProtocolError(
      'invalid_privacy_posture',
      'a cloud host must honestly declare cloud egress',
    );
  }
  return {
    supportsHumanApproval,
    cloudEgress,
    secretDelivery: 'opaque_reference_only',
  };
}

/** Throws unless the value is a well-formed step requirement (fail closed). */
function validateStepRequirement(value: unknown): StepCapabilityRequirement {
  if (!isRecord(value)) {
    throw new NodeCapabilityProtocolError('invalid_workflow_request', 'step requirement is not an object');
  }
  const stepId = value['stepId'];
  if (!isNonEmptyString(stepId)) {
    throw new NodeCapabilityProtocolError('invalid_workflow_request', 'step.stepId must be a non-empty string');
  }
  const capability = value['capability'];
  if (!isNonEmptyString(capability) || !isCanonicalCapabilityName(capability)) {
    throw new NodeCapabilityProtocolError(
      'invalid_capability_name',
      `step ${stepId}: non-canonical capability name ${String(capability)}`,
    );
  }
  const executionClass = value['executionClass'];
  if (typeof executionClass !== 'string' || !isCanonicalExecutionClass(executionClass)) {
    throw new NodeCapabilityProtocolError(
      'invalid_execution_class',
      `step ${stepId}: non-canonical execution class ${String(executionClass)}`,
    );
  }
  const fallbackExecutionClasses = value['fallbackExecutionClasses'];
  if (fallbackExecutionClasses !== undefined) {
    if (!Array.isArray(fallbackExecutionClasses)) {
      throw new NodeCapabilityProtocolError(
        'invalid_execution_class',
        `step ${stepId}: fallbackExecutionClasses must be an array`,
      );
    }
    for (const fallback of fallbackExecutionClasses) {
      if (typeof fallback !== 'string' || !isCanonicalExecutionClass(fallback)) {
        throw new NodeCapabilityProtocolError(
          'invalid_execution_class',
          `step ${stepId}: non-canonical fallback execution class ${String(fallback)}`,
        );
      }
    }
  }
  const placement = value['placement'];
  if (typeof placement !== 'string' || !isCanonicalPlacementConstraint(placement)) {
    throw new NodeCapabilityProtocolError(
      'invalid_placement_constraint',
      `step ${stepId}: non-canonical placement constraint ${String(placement)}`,
    );
  }
  const privacy = value['privacy'];
  if (!isRecord(privacy)) {
    throw new NodeCapabilityProtocolError('invalid_privacy_constraint', `step ${stepId}: privacy constraints are required`);
  }
  const dataLocality = privacy['dataLocality'];
  if (typeof dataLocality !== 'string' || !DATA_LOCALITIES.has(dataLocality)) {
    throw new NodeCapabilityProtocolError(
      'invalid_privacy_constraint',
      `step ${stepId}: invalid data locality ${String(dataLocality)}`,
    );
  }
  const requiresHumanApproval = privacy['requiresHumanApproval'];
  if (typeof requiresHumanApproval !== 'boolean') {
    throw new NodeCapabilityProtocolError(
      'invalid_privacy_constraint',
      `step ${stepId}: privacy.requiresHumanApproval must be boolean`,
    );
  }
  const assuranceFloor = value['assuranceFloor'];
  if (assuranceFloor !== undefined) {
    if (typeof assuranceFloor !== 'string' || !isCanonicalAssuranceLevel(assuranceFloor)) {
      throw new NodeCapabilityProtocolError(
        'invalid_assurance_level',
        `step ${stepId}: non-canonical assurance floor ${String(assuranceFloor)}`,
      );
    }
  }
  return {
    stepId,
    capability,
    executionClass: executionClass as ExecutionClass,
    ...(fallbackExecutionClasses !== undefined
      ? { fallbackExecutionClasses: [...fallbackExecutionClasses] as ExecutionClass[] }
      : {}),
    placement: placement as PlacementConstraint,
    privacy: { dataLocality: dataLocality as StepCapabilityRequirement['privacy']['dataLocality'], requiresHumanApproval },
    ...(assuranceFloor !== undefined ? { assuranceFloor: assuranceFloor as StepCapabilityRequirement['assuranceFloor'] } : {}),
  };
}

function validateWorkflowRequest(value: unknown): WorkflowExecutionRequest {
  if (!isRecord(value)) {
    throw new NodeCapabilityProtocolError('invalid_workflow_request', 'workflow request is not an object');
  }
  const workflowVersionRef = value['workflowVersionRef'];
  if (!isNonEmptyString(workflowVersionRef)) {
    throw new NodeCapabilityProtocolError(
      'invalid_workflow_request',
      'workflowVersionRef must be a non-empty string',
    );
  }
  const steps = value['steps'];
  if (!Array.isArray(steps)) {
    throw new NodeCapabilityProtocolError('invalid_workflow_request', 'steps must be an array');
  }
  return {
    workflowVersionRef,
    steps: steps.map((step) => validateStepRequirement(step)),
  };
}

function validateAuthorizationDecision(value: unknown): AuthorizationDecision {
  if (!isRecord(value)) {
    throw new NodeCapabilityProtocolError('invalid_authorization_decision', 'authorization decision is not an object');
  }
  const principal = value['principal'];
  if (!isNonEmptyString(principal)) {
    throw new NodeCapabilityProtocolError(
      'invalid_authorization_decision',
      'authorization.principal must be a non-empty string',
    );
  }
  const status = value['status'];
  if (typeof status !== 'string' || !AUTHORIZATION_STATUSES.has(status)) {
    throw new NodeCapabilityProtocolError(
      'invalid_authorization_decision',
      `authorization.status must be 'authorized' or 'denied' (got ${String(status)})`,
    );
  }
  const subject = value['subject'];
  if (!isNonEmptyString(subject)) {
    throw new NodeCapabilityProtocolError(
      'invalid_authorization_decision',
      'authorization.subject must be a non-empty string',
    );
  }
  return { principal, status: status as AuthorizationDecision['status'], subject };
}

/**
 * Inline secret material scan (constitution §16): any secret-named key must
 * carry an OPAQUE reference (secretref:...) or be absent — raw secret values
 * are rejected at the protocol boundary.
 */
function assertOpaqueSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const element of value) {
      assertOpaqueSecrets(element);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, member] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      if (member === null || member === undefined) {
        continue;
      }
      if (typeof member === 'string' && member.startsWith(OPAQUE_SECRET_REFERENCE_PREFIX)) {
        continue;
      }
      throw new NodeCapabilityProtocolError(
        'opaque_secret_reference_required',
        `inline secret material under key "${key}" — secrets must be referenced opaquely (${OPAQUE_SECRET_REFERENCE_PREFIX}...)`,
      );
    }
    assertOpaqueSecrets(member);
  }
}

/**
 * Placement classification (constitution §12 — locality is a correctness
 * constraint, not a performance hint). `null` means the placement constraint
 * is FORBIDDEN for the node's locality class.
 */
function classifyPlacement(
  placement: PlacementConstraint,
  nodeLocality: 'device' | 'cloud',
): PlacementTier | null {
  switch (placement) {
    case 'device_local':
      return nodeLocality === 'device' ? 'exact' : null;
    case 'cloud_required':
      return nodeLocality === 'cloud' ? 'exact' : null;
    case 'device_preferred':
      return nodeLocality === 'device' ? 'preferred' : 'fallback';
    case 'cloud_preferred':
      return nodeLocality === 'cloud' ? 'preferred' : 'fallback';
    case 'cloud_allowed':
    case 'any_supported_node':
      return 'neutral';
  }
}

/** The authorization dimension for a whole-workflow evaluation. */
function workflowAuthorizationReason(
  authorization: AuthorizationDecision | null,
  workflowVersionRef: string,
): EligibilityReason | null {
  if (authorization === null) {
    return 'authorization_missing';
  }
  if (authorization.subject !== workflowVersionRef) {
    return 'authorization_scope_mismatch';
  }
  if (authorization.status === 'denied') {
    return 'authorization_denied';
  }
  return null;
}

export function createNodeCapabilityService(
  options: NodeCapabilityServiceOptions,
): NodeCapabilityService {
  const keyDirectory = options.keyDirectory;
  const nodes = new Map<string, NodeRecord>();
  const keyBindings = new Map<
    string,
    { nodeId: string; ownerPrincipal: string; platformClass: HostPlatformClass }
  >();
  const hostHandlers = new Map<string, Map<string, HostCapabilityHandler>>();

  function requireNode(nodeId: string): NodeRecord {
    const record = nodes.get(nodeId);
    if (!record) {
      throw new NodeCapabilityProtocolError('node_unknown', `no node registered with id ${nodeId}`);
    }
    return record;
  }

  function registerNode(request: NodeRegistrationRequest): NodeDescriptor {
    if (!isRecord(request)) {
      throw new NodeCapabilityProtocolError('invalid_registration', 'registration request is not an object');
    }
    const nodeKeyFingerprint = request.nodeKeyFingerprint;
    if (typeof nodeKeyFingerprint !== 'string') {
      throw new NodeCapabilityProtocolError('unknown_node_key', 'nodeKeyFingerprint must be a string');
    }
    // 1. Out-of-band key lookup — fail closed when the key is unknown.
    const secret = keyDirectory.resolve(nodeKeyFingerprint);
    if (secret === null) {
      throw new NodeCapabilityProtocolError(
        'unknown_node_key',
        `no host key material registered for fingerprint ${nodeKeyFingerprint}`,
      );
    }
    // 2. Authentication — the HMAC covers the canonical payload.
    const auth = request.auth;
    if (!isRecord(auth) || auth['algorithm'] !== 'hmac-sha256' || typeof auth['digest'] !== 'string') {
      throw new NodeCapabilityProtocolError(
        'node_authentication_failed',
        'registration auth must be an hmac-sha256 digest object',
      );
    }
    const { auth: _stripped, ...payload } = request;
    const expected = signRegistrationPayload(payload as Omit<NodeRegistrationRequest, 'auth'>, secret);
    if (!digestsEqual(expected.digest, auth['digest'])) {
      throw new NodeCapabilityProtocolError(
        'node_authentication_failed',
        'registration payload failed HMAC authentication (tampered or mis-signed)',
      );
    }
    // 3. Protocol version negotiation — foreign majors are explicit rejections.
    const protocolVersion = request.protocolVersion;
    if (typeof protocolVersion !== 'string') {
      throw new NodeCapabilityProtocolError('protocol_version_mismatch', 'protocolVersion must be a string');
    }
    const negotiation = negotiateProtocolVersion(protocolVersion, CURRENT_PROTOCOL_VERSION);
    if (!negotiation.compatible) {
      throw new NodeCapabilityProtocolError(
        'protocol_version_mismatch',
        `registration protocol version ${protocolVersion} is incompatible with ${CURRENT_PROTOCOL_VERSION}`,
      );
    }
    // 4. Structural validation (registry-canonical names, honest postures).
    const platformClass = request.platformClass;
    if (
      typeof platformClass !== 'string' ||
      !HOST_PLATFORM_CLASSES.includes(platformClass as HostPlatformClass)
    ) {
      throw new NodeCapabilityProtocolError(
        'invalid_registration',
        `platformClass must be one of ${HOST_PLATFORM_CLASSES.join(', ')} (got ${String(platformClass)})`,
      );
    }
    const ownerPrincipal = request.ownerPrincipal;
    if (!isNonEmptyString(ownerPrincipal)) {
      throw new NodeCapabilityProtocolError('invalid_registration', 'ownerPrincipal must be a non-empty string');
    }
    const registrationSequence = request.registrationSequence;
    if (
      typeof registrationSequence !== 'number' ||
      !Number.isInteger(registrationSequence) ||
      registrationSequence < 1
    ) {
      throw new NodeCapabilityProtocolError(
        'invalid_registration',
        'registrationSequence must be a positive integer',
      );
    }
    const privacyPosture = validatePrivacyPosture(request.privacyPosture, platformClass as HostPlatformClass);
    const advertisementsValue = request.advertisements;
    if (!Array.isArray(advertisementsValue)) {
      throw new NodeCapabilityProtocolError('invalid_registration', 'advertisements must be an array');
    }
    const advertisements = advertisementsValue.map((advertisement) => validateAdvertisement(advertisement));
    const seenCapabilities = new Set<string>();
    for (const advertisement of advertisements) {
      if (seenCapabilities.has(advertisement.capability)) {
        throw new NodeCapabilityProtocolError(
          'invalid_registration',
          `duplicate advertisement for capability ${advertisement.capability} in one registration`,
        );
      }
      seenCapabilities.add(advertisement.capability);
    }
    // 5. Identity integrity — a key may re-bind neither platform class nor owner.
    const binding = keyBindings.get(nodeKeyFingerprint);
    if (
      binding !== undefined &&
      (binding.ownerPrincipal !== ownerPrincipal || binding.platformClass !== platformClass)
    ) {
      throw new NodeCapabilityProtocolError(
        'invalid_registration',
        `host key ${nodeKeyFingerprint} is already bound to another node identity (${binding.ownerPrincipal}/${binding.platformClass}); platform class and owner principal are identity inputs and may not be re-bound`,
      );
    }
    // 6. Registration sequence freshness — replays are stale.
    const nodeId = computeNodeId({
      keyFingerprint: nodeKeyFingerprint,
      ownerPrincipal,
      platformClass: platformClass as HostPlatformClass,
    });
    const existing = nodes.get(nodeId);
    if (existing !== undefined && registrationSequence <= existing.registrationSequence) {
      throw new NodeCapabilityProtocolError(
        'stale_registration',
        `registration sequence ${registrationSequence} is not newer than ${existing.registrationSequence}`,
      );
    }
    // 7. Advertisement versioning — monotonic versions, immutable content.
    if (existing !== undefined) {
      for (const advertisement of advertisements) {
        const stored = existing.capabilities.get(advertisement.capability);
        if (stored === undefined) {
          continue;
        }
        if (advertisement.capabilityVersion < stored.capabilityVersion) {
          throw new NodeCapabilityProtocolError(
            'stale_capability_advertisement',
            `capability ${advertisement.capability}: version ${advertisement.capabilityVersion} is older than the advertised ${stored.capabilityVersion}`,
          );
        }
        if (advertisement.capabilityVersion === stored.capabilityVersion) {
          const storedContent = canonicalJsonStringify({
            executionClasses: stored.executionClasses,
            health: stored.health,
            trust: stored.trust,
          });
          const incomingContent = canonicalJsonStringify({
            executionClasses: advertisement.executionClasses,
            health: advertisement.health,
            trust: advertisement.trust,
          });
          if (storedContent !== incomingContent) {
            throw new NodeCapabilityProtocolError(
              'capability_advertisement_conflict',
              `capability ${advertisement.capability}: version ${advertisement.capabilityVersion} is already advertised with different content — advertisement versions are immutable`,
            );
          }
        }
      }
    }
    // 8. Commit (atomic: every check above threw before any state change).
    const capabilities = new Map<string, CapabilityAdvertisement>();
    for (const advertisement of advertisements) {
      capabilities.set(advertisement.capability, cloneAdvertisement(advertisement));
    }
    const record: NodeRecord = {
      nodeId,
      keyFingerprint: nodeKeyFingerprint,
      ownerPrincipal,
      platformClass: platformClass as HostPlatformClass,
      protocolVersion: negotiation.negotiatedVersion ?? CURRENT_PROTOCOL_VERSION,
      registrationSequence,
      privacyPosture: clonePrivacyPosture(privacyPosture),
      capabilities,
      invocationSequence: existing !== undefined ? existing.invocationSequence : 0,
    };
    nodes.set(nodeId, record);
    keyBindings.set(nodeKeyFingerprint, {
      nodeId,
      ownerPrincipal,
      platformClass: platformClass as HostPlatformClass,
    });
    return descriptorOf(record);
  }

  function discoverNodes(): NodeDescriptor[] {
    return [...nodes.values()]
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
      .map(descriptorOf);
  }

  function decideStep(
    record: NodeRecord,
    step: StepCapabilityRequirement,
    authorizationReason: EligibilityReason | null,
    nodeLocality: 'device' | 'cloud',
  ): StepEligibilityDecision {
    const reasons: EligibilityReason[] = [];
    const advertised = record.capabilities.get(step.capability) ?? null;

    // Resolved execution class: the declared class first, then ONLY the
    // fallback classes the workflow itself declared (never a silent
    // substitution — constitution §6).
    let resolvedExecutionClass: ExecutionClass | null = null;
    let viaDeclaredFallback = false;

    // Dimension 1 — capability availability.
    if (advertised === null) {
      reasons.push('capability_missing');
    } else {
      if (advertised.executionClasses.includes(step.executionClass)) {
        resolvedExecutionClass = step.executionClass;
      } else {
        const fallback = (step.fallbackExecutionClasses ?? []).find((candidate) =>
          advertised.executionClasses.includes(candidate),
        );
        if (fallback !== undefined) {
          resolvedExecutionClass = fallback;
          viaDeclaredFallback = true;
        }
      }
      // Reason order is the canonical report order: health, execution class,
      // trust, assurance.
      if (advertised.health !== 'healthy') {
        reasons.push('capability_unhealthy');
      }
      if (resolvedExecutionClass === null) {
        reasons.push('execution_class_unsupported');
      }
      // Trust — an explicit dimension, never inferred.
      if (advertised.trust.trustLevel === 'unverified') {
        reasons.push('trust_unverified');
      }
      // Assurance floor — absence is below every floor (never silently accepted).
      if (step.assuranceFloor !== undefined) {
        const assurance = advertised.trust.assurance;
        const belowFloor =
          assurance === null || assuranceStrength(assurance) < assuranceStrength(step.assuranceFloor);
        if (belowFloor) {
          reasons.push('assurance_below_floor');
        }
      }
    }

    // Dimension 2a — placement constraints (locality is a correctness rule).
    const placementTier = classifyPlacement(step.placement, nodeLocality);
    if (placementTier === null) {
      reasons.push('placement_forbidden');
    }

    // Dimension 2b — privacy constraints (workflow policy).
    if (step.privacy.dataLocality === 'device_only') {
      const deviceLocal = nodeLocality === 'device' && record.privacyPosture.cloudEgress === 'none';
      if (!deviceLocal) {
        reasons.push('privacy_data_locality');
      }
    }
    if (step.privacy.requiresHumanApproval && !record.privacyPosture.supportsHumanApproval) {
      reasons.push('privacy_human_approval_unsupported');
    }

    // Dimension 3 — user/organization authorization (external authority).
    if (authorizationReason !== null) {
      reasons.push(authorizationReason);
    }

    return {
      stepId: step.stepId,
      capability: step.capability,
      eligible: reasons.length === 0,
      reasons,
      advertised: advertised === null ? null : cloneAdvertisement(advertised),
      resolvedExecutionClass,
      viaDeclaredFallback,
      placementTier,
    };
  }

  function evaluateNode(
    nodeId: string,
    request: WorkflowExecutionRequest,
    authorization: AuthorizationDecision | null,
  ): WorkflowEligibilityEvaluation {
    const record = requireNode(nodeId);
    const workflow = validateWorkflowRequest(request);
    let decision: AuthorizationDecision | null = null;
    if (authorization !== null) {
      decision = validateAuthorizationDecision(authorization);
    }
    const authorizationReason = workflowAuthorizationReason(decision, workflow.workflowVersionRef);
    const nodeLocality: 'device' | 'cloud' = record.platformClass === 'cloud' ? 'cloud' : 'device';
    const steps = workflow.steps.map((step) => decideStep(record, step, authorizationReason, nodeLocality));
    return {
      nodeId: record.nodeId,
      workflowVersionRef: workflow.workflowVersionRef,
      workflowEligible: steps.every((step) => step.eligible),
      steps,
    };
  }

  function attachHostHandler(
    nodeId: string,
    capability: string,
    executionClass: ExecutionClass,
    handler: HostCapabilityHandler,
  ): void {
    const record = requireNode(nodeId);
    if (typeof capability !== 'string' || !isCanonicalCapabilityName(capability)) {
      throw new NodeCapabilityProtocolError(
        'invalid_capability_name',
        `non-canonical capability name: ${String(capability)}`,
      );
    }
    if (typeof executionClass !== 'string' || !isCanonicalExecutionClass(executionClass)) {
      throw new NodeCapabilityProtocolError(
        'invalid_execution_class',
        `non-canonical execution class: ${String(executionClass)}`,
      );
    }
    if (typeof handler !== 'function') {
      throw new NodeCapabilityProtocolError('invalid_registration', 'host handler must be a function');
    }
    let nodeHandlers = hostHandlers.get(record.nodeId);
    if (nodeHandlers === undefined) {
      nodeHandlers = new Map<string, HostCapabilityHandler>();
      hostHandlers.set(record.nodeId, nodeHandlers);
    }
    nodeHandlers.set(handlerKey(capability, executionClass), handler);
  }

  function invokeCapability(
    nodeId: string,
    request: CapabilityInvocationRequest,
  ): CapabilityInvocationRecord {
    const record = requireNode(nodeId);
    if (!isRecord(request)) {
      throw new NodeCapabilityProtocolError('invalid_invocation_request', 'invocation request is not an object');
    }
    const stepId = request.stepId;
    if (!isNonEmptyString(stepId)) {
      throw new NodeCapabilityProtocolError('invalid_invocation_request', 'stepId must be a non-empty string');
    }
    const capability = request.capability;
    if (typeof capability !== 'string' || !isCanonicalCapabilityName(capability)) {
      throw new NodeCapabilityProtocolError(
        'invalid_capability_name',
        `non-canonical capability name: ${String(capability)}`,
      );
    }
    const executionClass = request.executionClass;
    if (typeof executionClass !== 'string' || !isCanonicalExecutionClass(executionClass)) {
      throw new NodeCapabilityProtocolError(
        'invalid_execution_class',
        `non-canonical execution class: ${String(executionClass)}`,
      );
    }
    let authorization: AuthorizationDecision | null = null;
    if (request.authorization !== null && request.authorization !== undefined) {
      authorization = validateAuthorizationDecision(request.authorization);
    }
    // The authorization gate: possession never executes by itself.
    if (authorization === null) {
      throw new NodeCapabilityProtocolError(
        'authorization_required',
        'capability invocation requires an explicit authorization decision',
      );
    }
    if (authorization.subject !== capability) {
      throw new NodeCapabilityProtocolError(
        'authorization_scope_mismatch',
        `authorization decision is bound to ${authorization.subject}, not to capability ${capability}`,
      );
    }
    if (authorization.status === 'denied') {
      throw new NodeCapabilityProtocolError(
        'authorization_denied',
        'the authorization decision for this capability is denied',
      );
    }
    // The capability gate: unadvertised capabilities are never emulated.
    const advertised = record.capabilities.get(capability);
    if (advertised === undefined) {
      throw new NodeCapabilityProtocolError(
        'capability_missing',
        `capability ${capability} is not advertised by node ${record.nodeId}`,
      );
    }
    if (advertised.health !== 'healthy') {
      throw new NodeCapabilityProtocolError(
        'capability_unhealthy',
        `capability ${capability} is currently ${advertised.health}`,
      );
    }
    if (advertised.trust.trustLevel === 'unverified') {
      throw new NodeCapabilityProtocolError(
        'trust_unverified',
        `capability ${capability} is advertised by an unverified node`,
      );
    }
    if (!advertised.executionClasses.includes(executionClass as ExecutionClass)) {
      throw new NodeCapabilityProtocolError(
        'execution_class_unsupported',
        `capability ${capability} does not support execution class ${executionClass} on this node`,
      );
    }
    assertOpaqueSecrets(request.input);
    const handler = hostHandlers.get(record.nodeId)?.get(handlerKey(capability, executionClass));
    if (handler === undefined) {
      throw new NodeCapabilityProtocolError(
        'capability_execution_unavailable',
        `no host handler attached for capability ${capability} with execution class ${executionClass}`,
      );
    }
    let output: unknown;
    try {
      output = handler(request.input);
    } catch (cause) {
      throw new NodeCapabilityProtocolError(
        'capability_execution_failed',
        `host handler for capability ${capability} failed: ${String(cause)}`,
      );
    }
    record.invocationSequence += 1;
    return {
      nodeId: record.nodeId,
      stepId,
      capability,
      executionClass: executionClass as ExecutionClass,
      invocationSequence: record.invocationSequence,
      event: 'capability.invocation.completed',
      evidenceClass: 'observation',
      input: request.input,
      output,
    };
  }

  return {
    registerNode,
    discoverNodes,
    evaluateNode,
    attachHostHandler,
    invokeCapability,
  };
}

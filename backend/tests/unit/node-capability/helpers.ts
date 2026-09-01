/**
 * V2-004 — Node + Capability Protocol: deterministic test helpers.
 *
 * Shared builders for the node/capability/placement battery. Everything here
 * is deterministic: fixed seeds, fixed principals, no wall-clock time, no
 * randomness. The battery can therefore run byte-identically twice.
 *
 * Authority model reminder (constitution §5, V2-CTRL-003 authorityRules):
 * a Node advertises capability; capability does not grant authorization.
 * The helpers therefore always keep the node key material OUT of protocol
 * payloads (it is delivered out-of-band through the NodeKeyDirectory, exactly
 * like V1's apiKey secretRef indirection).
 */
import {
  createNodeCapabilityService,
  createNodeKeyDirectory,
  deriveNodeKeyFingerprint,
  signRegistrationPayload,
  CURRENT_PROTOCOL_VERSION,
  type AuthorizationDecision,
  type CapabilityAdvertisement,
  type NodeCapabilityService,
  type NodeKeyDirectory,
  type NodePrivacyPosture,
  type NodeRegistrationRequest,
  type PrivacyConstraints,
  type StepCapabilityRequirement,
  type TrustAttributes,
  type WorkflowExecutionRequest,
} from '../../../src/node-capability/index.js';

/** Deterministic node key material (host-side secret; never enters payloads). */
export function makeNodeKeyMaterial(seed: string): { secret: string; fingerprint: string } {
  const secret = `node-key-material::${seed}`;
  return { secret, fingerprint: deriveNodeKeyFingerprint(secret) };
}

/** A deterministic key directory holding host secrets out-of-band. */
export function makeKeyDirectory(
  entries: ReadonlyArray<{ seed: string }>,
): NodeKeyDirectory {
  return createNodeKeyDirectory(
    entries.map(({ seed }) => {
      const { secret, fingerprint } = makeNodeKeyMaterial(seed);
      return { keyFingerprint: fingerprint, secret };
    }),
  );
}

/** Default trust for fixture nodes — verified, software_signed (registry ids). */
export const FIXTURE_TRUST: TrustAttributes = {
  trustLevel: 'verified',
  assurance: 'software_signed',
};

/** A healthy advertisement of one canonical capability. */
export function advertisement(
  capability: string,
  executionClasses: ReadonlyArray<string>,
  overrides: Partial<CapabilityAdvertisement> = {},
): CapabilityAdvertisement {
  return {
    capability,
    capabilityVersion: 1,
    executionClasses: [...executionClasses],
    health: 'healthy',
    trust: FIXTURE_TRUST,
    ...overrides,
  };
}

/** A device host privacy posture with no cloud egress and human approval support. */
export const DEVICE_LOCAL_POSTURE: NodePrivacyPosture = {
  supportsHumanApproval: true,
  cloudEgress: 'none',
  secretDelivery: 'opaque_reference_only',
};

/** A cloud host privacy posture — cloud nodes must honestly declare egress. */
export const CLOUD_POSTURE: NodePrivacyPosture = {
  supportsHumanApproval: false,
  cloudEgress: 'allowed',
  secretDelivery: 'opaque_reference_only',
};

export interface RegistrationOverrides {
  platformClass?: NodeRegistrationRequest['platformClass'];
  ownerPrincipal?: string;
  protocolVersion?: string;
  registrationSequence?: number;
  advertisements?: ReadonlyArray<CapabilityAdvertisement>;
  privacyPosture?: NodePrivacyPosture;
}

/**
 * Builds a SIGNED registration request. The HMAC is computed over the
 * canonical JSON of the payload without the auth field.
 */
export function buildRegistration(
  keySeed: string,
  overrides: RegistrationOverrides = {},
): NodeRegistrationRequest {
  const { secret, fingerprint } = makeNodeKeyMaterial(keySeed);
  const payload = {
    nodeKeyFingerprint: fingerprint,
    platformClass: overrides.platformClass ?? 'desktop',
    ownerPrincipal: overrides.ownerPrincipal ?? 'user:fixture-operator',
    protocolVersion: overrides.protocolVersion ?? CURRENT_PROTOCOL_VERSION,
    registrationSequence: overrides.registrationSequence ?? 1,
    advertisements: [
      ...(overrides.advertisements ?? [
        advertisement('filesystem.read', ['deterministic_api']),
        advertisement('filesystem.write', ['deterministic_api']),
        advertisement('application.open', ['deterministic_api', 'agentic_computer_use']),
      ]),
    ],
    privacyPosture: overrides.privacyPosture ?? DEVICE_LOCAL_POSTURE,
  };
  return { ...payload, auth: signRegistrationPayload(payload, secret) };
}

/** A default privacy block: data may stay on the device, no human approval. */
export const OPEN_PRIVACY: PrivacyConstraints = {
  dataLocality: 'device_or_cloud',
  requiresHumanApproval: false,
};

/** A workflow requirement step with deterministic defaults. */
export function step(
  stepId: string,
  capability: string,
  overrides: Partial<StepCapabilityRequirement> = {},
): StepCapabilityRequirement {
  return {
    stepId,
    capability,
    executionClass: 'deterministic_api',
    placement: 'any_supported_node',
    privacy: OPEN_PRIVACY,
    ...overrides,
  };
}

/** A minimal one-step workflow request. */
export function workflowRequest(
  stepsList: ReadonlyArray<StepCapabilityRequirement>,
  workflowVersionRef = 'workflow-version:fixture:unit@1',
): WorkflowExecutionRequest {
  return { workflowVersionRef, steps: [...stepsList] };
}

/** An explicit authorization decision (external authority input dimension). */
export function authorization(
  status: 'authorized' | 'denied',
  subject: string,
  principal = 'user:fixture-operator',
): AuthorizationDecision {
  return { principal, status, subject };
}

/** Registers a node and returns the service + descriptor nodeId. */
export function registerFixtureNode(
  service: NodeCapabilityService,
  keySeed: string,
  overrides: RegistrationOverrides = {},
): { nodeId: string } {
  const descriptor = service.registerNode(buildRegistration(keySeed, overrides));
  return { nodeId: descriptor.nodeId };
}

/** A fresh service wired with the given key seeds' directory. */
export function makeService(keySeeds: ReadonlyArray<string>): NodeCapabilityService {
  return createNodeCapabilityService({
    keyDirectory: makeKeyDirectory(keySeeds.map((seed) => ({ seed }))),
  });
}

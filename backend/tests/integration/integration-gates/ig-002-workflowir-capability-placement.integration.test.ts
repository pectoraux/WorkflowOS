/**
 * IG-002 — WorkflowIR ↔ Node Capability / Placement Integration Gate.
 *
 * Frozen scope only: V2-003 WorkflowIR remains platform-neutral while V2-004
 * resolves canonical capability and placement requirements against concrete
 * hosts. The projection from IR to NodeRequirementSet is deliberately test
 * local: V2-004 explicitly consumes requirements as data and must not absorb
 * WorkflowIR semantics.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DefaultNodeCapabilityService,
  computeRegistrationResponse,
  type CapabilityAdvertisement,
  type NodeCapabilityService,
  type NodePlatformClass,
  type NodeRequirementSet,
} from '../../../src/node-capability/index.js';
import {
  buildMinimalDocument,
  withNode,
  type WorkflowIrDocument,
} from '../../unit/workflow-ir/helpers.js';
import {
  computeWorkflowVersionSemanticDigest,
  validateWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';

const CLOCK_BASE = 1_733_568_000_000;
const LEASE_MS = 60_000;

const CLOUD_SECRET = createHash('sha256').update('ig-002-cloud').digest();
const DEVICE_SECRET = createHash('sha256').update('ig-002-device').digest();

const CLOUD_CAPABILITIES: readonly CapabilityAdvertisement[] = [
  { name: 'workflow.execute', version: 1, availability: 'available' },
  { name: 'workflow.observe', version: 1, availability: 'available' },
  { name: 'github.repository.read', version: 1, availability: 'available' },
];

const DEVICE_CAPABILITIES: readonly CapabilityAdvertisement[] = [
  { name: 'workflow.observe', version: 1, availability: 'available' },
  { name: 'browser.navigate', version: 1, availability: 'available' },
  { name: 'browser.click', version: 1, availability: 'available' },
];

function register(
  service: NodeCapabilityService,
  secret: Uint8Array,
  platformClass: NodePlatformClass,
  capabilities: readonly CapabilityAdvertisement[],
  supportsHumanApproval: boolean,
) {
  const { nodeKeyFingerprint } = service.enrollNodeKey({ nodeKeySecret: secret });
  const challenge = service.requestRegistrationChallenge({ nodeKeyFingerprint });
  const payload = {
    nodeKeyFingerprint,
    platformClass,
    protocolVersion: 1,
    capabilities,
    attributes: { supportsHumanApproval, health: 'healthy' as const },
  };
  const response = computeRegistrationResponse({ nodeKeySecret: secret, payload, nonce: challenge.nonce });
  const session = service.completeRegistration({
    ...payload,
    challengeNonce: challenge.nonce,
    response,
  });
  service.setNodeTrustAttributes({ nodeId: session.nodeId, trustTier: 'trusted' });
  return { ...session, nodeKeyFingerprint };
}

/** The only adapter in this gate; V2-004 receives the resulting requirement as data. */
function requirementFromIr(nodeId: string, document: WorkflowIrDocument): NodeRequirementSet {
  const node = document.ir.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`IG-002 fixture missing node ${nodeId}`);
  return {
    id: `IG-002-${node.id}`,
    capabilities: node.capabilityRequirements.map((name) => ({ name })),
    placement: { required: node.placement },
    ...(node.placement === 'device_local' ? { privacy: { localOnly: true } } : {}),
  };
}

describe('IG-002 — platform-neutral WorkflowIR capability + placement compatibility', () => {
  function buildService() {
    let now = CLOCK_BASE;
    let nonce = 0;
    const service = new DefaultNodeCapabilityService({
      clock: () => now,
      nonceSource: () => (++nonce).toString(16).padStart(16, '0'),
      heartbeatLeaseTtlMs: LEASE_MS,
    });
    const cloud = register(service, CLOUD_SECRET, 'cloud', CLOUD_CAPABILITIES, false);
    const device = register(service, DEVICE_SECRET, 'web', DEVICE_CAPABILITIES, true);
    return {
      service,
      cloud,
      device,
      advance: (ms: number) => { now += ms; },
    };
  }

  it('uses only canonical IR capability names and placement ids, while preserving semantic identity', () => {
    const source = buildMinimalDocument();
    const workflow = withNode(source, 'observe', {
      spec: { class: 'deterministic_api', capability: 'workflow.observe' },
      capabilityRequirements: ['workflow.observe'],
      placement: 'cloud_allowed',
    });
    expect(validateWorkflowIrDocument(workflow).ok).toBe(true);

    const requirement = requirementFromIr('observe', workflow);
    expect(requirement.capabilities.map((capability) => capability.name)).toEqual(['workflow.observe']);
    expect(requirement.placement.required).toBe('cloud_allowed');
    expect(computeWorkflowVersionSemanticDigest(workflow).digest).toBe(
      computeWorkflowVersionSemanticDigest(
        withNode(source, 'observe', {
          spec: { class: 'deterministic_api', capability: 'workflow.observe' },
          capabilityRequirements: ['workflow.observe'],
          placement: 'cloud_allowed',
        }),
      ).digest,
    );
  });

  it('matches a shared capability on two different eligible host classes with equivalent compatibility', () => {
    const { service } = buildService();
    const workflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'workflow.observe' },
      capabilityRequirements: ['workflow.observe'],
      placement: 'any_supported_node',
    });
    const result = service.matchNodes(requirementFromIr('observe', workflow));
    expect(result.eligibleNodes).toHaveLength(2);
    expect(result.evaluations.every((evaluation) => evaluation.capabilityEligible)).toBe(true);
    expect(result.evaluations.every((evaluation) => evaluation.protocolEligible)).toBe(true);
    expect(result.evaluations.every((evaluation) => evaluation.trustEligible)).toBe(true);
  });

  it('keeps authorization distinct from capability possession', () => {
    const { service } = buildService();
    const workflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_required',
    });
    const result = service.matchNodes(requirementFromIr('observe', workflow));
    const cloud = result.evaluations.find((evaluation) => evaluation.platformClass === 'cloud');
    const device = result.evaluations.find((evaluation) => evaluation.platformClass === 'web');
    expect(cloud?.capabilityEligible).toBe(true);
    expect(device?.capabilityEligible).toBe(false);
    for (const evaluation of result.evaluations) {
      expect(evaluation).not.toHaveProperty('authorized');
      expect(evaluation).not.toHaveProperty('authorizationEligible');
    }
  });

  it('enforces placement/locality/privacy constraints and rejects an unsupported host class honestly', () => {
    const { service } = buildService();
    const localWorkflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'browser.navigate' },
      capabilityRequirements: ['browser.navigate'],
      placement: 'device_local',
    });
    const localRequirement = requirementFromIr('observe', localWorkflow);
    const result = service.matchNodes(localRequirement);
    const cloud = result.evaluations.find((evaluation) => evaluation.platformClass === 'cloud');
    const device = result.evaluations.find((evaluation) => evaluation.platformClass === 'web');
    expect(device?.eligible).toBe(true);
    expect(cloud?.eligible).toBe(false);
    expect(cloud?.placementEligible).toBe(false);
    expect(cloud?.reasons.some((reason) => reason.dimension === 'placement' || reason.dimension === 'privacy')).toBe(true);

    const impossibleWorkflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'browser.navigate' },
      capabilityRequirements: ['browser.navigate'],
      placement: 'cloud_required',
    });
    const impossible = service.matchNodes(requirementFromIr('observe', impossibleWorkflow));
    expect(impossible.eligibleNodes).toHaveLength(0);
    expect(impossible.evaluations.every((evaluation) => !evaluation.eligible)).toBe(true);
    expect(impossible.evaluations.some((evaluation) => evaluation.reasons.length > 0)).toBe(true);
  });

  it('resolves the same WorkflowIR meaning on two host classes while keeping host-specific capability differences explicit', () => {
    const { service } = buildService();
    const workflow = withNode(buildMinimalDocument(), 'observe', {
      spec: { class: 'deterministic_api', capability: 'workflow.observe' },
      capabilityRequirements: ['workflow.observe'],
      placement: 'any_supported_node',
    });
    const requirement = requirementFromIr('observe', workflow);
    const result = service.matchNodes(requirement);
    const views = result.evaluations.map((evaluation) => ({
      platformClass: evaluation.platformClass,
      capabilityEligible: evaluation.capabilityEligible,
      placementEligible: evaluation.placementEligible,
    }));
    expect(views).toEqual([
      expect.objectContaining({ capabilityEligible: true, placementEligible: true }),
      expect.objectContaining({ capabilityEligible: true, placementEligible: true }),
    ]);
  });
});

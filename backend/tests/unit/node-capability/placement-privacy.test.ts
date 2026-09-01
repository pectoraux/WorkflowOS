/**
 * V2-004 — Placement, locality and privacy constraints.
 *
 * Proves (constitution §12 "Locality is a correctness constraint, not merely a
 * performance hint"; work order "Must deliver": placement constraints —
 * required, preferred, fallback, locality, privacy and human approval):
 *   - canonical placement identifiers behave exactly as specified:
 *     device_local / cloud_required are hard constraints; device_preferred /
 *     cloud_preferred produce explicit preferred/fallback tiers;
 *     cloud_allowed / any_supported_node accept both locality classes;
 *   - invalid locality/placement is an explicit rejection
 *     (`placement_forbidden`) — cloud execution never silently satisfies a
 *     device-local requirement;
 *   - privacy constraints reject nodes that would violate them: device-only
 *     data locality rejects cloud nodes AND device nodes that egress to cloud;
 *   - human-approval requirements reject hosts that cannot surface approval;
 *   - secret material in invocation inputs is rejected — secrets must be
 *     referenced opaquely (constitution §16).
 */
import { describe, it, expect } from 'vitest';
import type { PlacementConstraint } from '../../../src/node-capability/index.js';
import {
  advertisement,
  authorization,
  CLOUD_POSTURE,
  DEVICE_LOCAL_POSTURE,
  makeService,
  registerFixtureNode,
  step,
  workflowRequest,
} from './helpers.js';

const WORKFLOW_REF = 'workflow-version:fixture:placement@1';

function evaluatePlacement(platformClass: 'desktop' | 'cloud', placement: PlacementConstraint) {
  const service = makeService([`placement-${platformClass}-${placement}`]);
  const { nodeId } = registerFixtureNode(service, `placement-${platformClass}-${placement}`, {
    platformClass,
    advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    privacyPosture: platformClass === 'cloud' ? CLOUD_POSTURE : DEVICE_LOCAL_POSTURE,
  });
  const evaluation = service.evaluateNode(
    nodeId,
    workflowRequest([step('read', 'filesystem.read', { placement })], WORKFLOW_REF),
    authorization('authorized', WORKFLOW_REF),
  );
  return evaluation.steps[0]!;
}

describe('V2-004 — placement constraints (canonical identifiers)', () => {
  it('device_local accepts a device node with the exact tier', () => {
    const decision = evaluatePlacement('desktop', 'device_local');
    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.placementTier).toBe('exact');
  });

  it('device_local REJECTS a cloud node (explicit placement_forbidden)', () => {
    const decision = evaluatePlacement('cloud', 'device_local');
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain('placement_forbidden');
    expect(decision.placementTier).toBeNull();
  });

  it('cloud_required accepts a cloud node with the exact tier', () => {
    const decision = evaluatePlacement('cloud', 'cloud_required');
    expect(decision.eligible).toBe(true);
    expect(decision.placementTier).toBe('exact');
  });

  it('cloud_required REJECTS a device node (explicit placement_forbidden)', () => {
    const decision = evaluatePlacement('desktop', 'cloud_required');
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain('placement_forbidden');
    expect(decision.placementTier).toBeNull();
  });

  it('device_preferred: device node is preferred, cloud node is an explicit fallback', () => {
    expect(evaluatePlacement('desktop', 'device_preferred').placementTier).toBe('preferred');
    expect(evaluatePlacement('cloud', 'device_preferred').placementTier).toBe('fallback');
    expect(evaluatePlacement('cloud', 'device_preferred').eligible).toBe(true);
  });

  it('cloud_preferred: cloud node is preferred, device node is an explicit fallback', () => {
    expect(evaluatePlacement('cloud', 'cloud_preferred').placementTier).toBe('preferred');
    expect(evaluatePlacement('desktop', 'cloud_preferred').placementTier).toBe('fallback');
    expect(evaluatePlacement('desktop', 'cloud_preferred').eligible).toBe(true);
  });

  it('cloud_allowed and any_supported_node accept both locality classes neutrally', () => {
    for (const placement of ['cloud_allowed', 'any_supported_node'] as const) {
      expect(evaluatePlacement('desktop', placement).placementTier).toBe('neutral');
      expect(evaluatePlacement('cloud', placement).placementTier).toBe('neutral');
      expect(evaluatePlacement('desktop', placement).eligible).toBe(true);
      expect(evaluatePlacement('cloud', placement).eligible).toBe(true);
    }
  });

  it('a placement violation is reported even when the capability is missing (no silent masking)', () => {
    const service = makeService(['placement-mask']);
    const { nodeId } = registerFixtureNode(service, 'placement-mask', {
      platformClass: 'cloud',
      advertisements: [advertisement('workflow.execute', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest(
        [step('local', 'phone.call.answer', { placement: 'device_local' })],
        WORKFLOW_REF,
      ),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.reasons).toEqual(['capability_missing', 'placement_forbidden']);
  });
});

describe('V2-004 — privacy constraints', () => {
  it('device_only data locality REJECTS a cloud node (privacy_data_locality)', () => {
    const service = makeService(['privacy-cloud']);
    const { nodeId } = registerFixtureNode(service, 'privacy-cloud', {
      platformClass: 'cloud',
      advertisements: [advertisement('contacts.read', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest(
        [
          step('lookup-contact', 'contacts.read', {
            placement: 'any_supported_node',
            privacy: { dataLocality: 'device_only', requiresHumanApproval: false },
          }),
        ],
        WORKFLOW_REF,
      ),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.eligible).toBe(false);
    expect(evaluation.steps[0]?.reasons).toEqual(['privacy_data_locality']);
  });

  it('device_only data locality REJECTS a device node that egresses data to cloud', () => {
    const service = makeService(['privacy-egress']);
    const { nodeId } = registerFixtureNode(service, 'privacy-egress', {
      platformClass: 'web',
      advertisements: [advertisement('contacts.read', ['deterministic_api'])],
      privacyPosture: { supportsHumanApproval: true, cloudEgress: 'allowed', secretDelivery: 'opaque_reference_only' },
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest(
        [
          step('lookup-contact', 'contacts.read', {
            privacy: { dataLocality: 'device_only', requiresHumanApproval: false },
          }),
        ],
        WORKFLOW_REF,
      ),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.reasons).toEqual(['privacy_data_locality']);
  });

  it('device_only data locality accepts a strict device node (cloudEgress: none)', () => {
    const service = makeService(['privacy-strict']);
    const { nodeId } = registerFixtureNode(service, 'privacy-strict', {
      platformClass: 'ios',
      advertisements: [advertisement('contacts.read', ['deterministic_api'])],
      privacyPosture: DEVICE_LOCAL_POSTURE,
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest(
        [
          step('lookup-contact', 'contacts.read', {
            placement: 'device_local',
            privacy: { dataLocality: 'device_only', requiresHumanApproval: false },
          }),
        ],
        WORKFLOW_REF,
      ),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.eligible).toBe(true);
  });

  it('device_or_cloud data locality accepts cloud nodes (constraint is the workflow policy, not a blanket rule)', () => {
    const service = makeService(['privacy-open']);
    const { nodeId } = registerFixtureNode(service, 'privacy-open', {
      platformClass: 'cloud',
      advertisements: [advertisement('social.post.publish', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest(
        [
          step('publish', 'social.post.publish', {
            placement: 'cloud_required',
            privacy: { dataLocality: 'device_or_cloud', requiresHumanApproval: false },
          }),
        ],
        WORKFLOW_REF,
      ),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.eligible).toBe(true);
  });

  it('a human-approval requirement REJECTS hosts that cannot surface approval', () => {
    const service = makeService(['privacy-human']);
    const { nodeId } = registerFixtureNode(service, 'privacy-human', {
      platformClass: 'cloud',
      advertisements: [advertisement('workflow.deploy', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest(
        [
          step('deploy', 'workflow.deploy', {
            placement: 'cloud_required',
            privacy: { dataLocality: 'device_or_cloud', requiresHumanApproval: true },
          }),
        ],
        WORKFLOW_REF,
      ),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.eligible).toBe(false);
    expect(evaluation.steps[0]?.reasons).toEqual(['privacy_human_approval_unsupported']);
  });

  it('a human-approval requirement accepts hosts that support approval', () => {
    const service = makeService(['privacy-human-ok']);
    const { nodeId } = registerFixtureNode(service, 'privacy-human-ok', {
      platformClass: 'desktop',
      advertisements: [advertisement('workflow.deploy', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest(
        [
          step('deploy', 'workflow.deploy', {
            privacy: { dataLocality: 'device_or_cloud', requiresHumanApproval: true },
          }),
        ],
        WORKFLOW_REF,
      ),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.eligible).toBe(true);
  });
});

describe('V2-004 — secret material stays opaque (constitution §16)', () => {
  function invokeWithInput(input: unknown) {
    const service = makeService(['secret-scan']);
    const { nodeId } = registerFixtureNode(service, 'secret-scan', {
      advertisements: [advertisement('github.repository.read', ['deterministic_api'])],
    });
    service.attachHostHandler(nodeId, 'github.repository.read', 'deterministic_api', () => ({
      observed: true,
    }));
    return () =>
      service.invokeCapability(nodeId, {
        stepId: 'read-repo',
        capability: 'github.repository.read',
        executionClass: 'deterministic_api',
        input,
        authorization: authorization('authorized', 'github.repository.read'),
      });
  }

  it('inline secret material in invocation inputs is rejected (opaque_secret_reference_required)', () => {
    for (const input of [
      { apiToken: 'ghp_literaltoken' },
      { password: 'hunter2' },
      { secret: 'raw-secret-value' },
      { credentials: { apiKey: 'abc' } },
      { nested: { deeper: { privateKey: '-----BEGIN KEY-----' } } },
    ]) {
      expect(invokeWithInput(input)).toThrowError(/opaque_secret_reference_required/);
    }
  });

  it('opaque secret references are accepted', () => {
    for (const input of [
      { secretRef: 'secretref:org/github-token' },
      { tokenRef: 'secretref:user/pat' },
      { path: '/tmp/report.json', passwordRef: 'secretref:tenant/vault-1' },
    ]) {
      expect(invokeWithInput(input)).not.toThrow();
    }
  });
});

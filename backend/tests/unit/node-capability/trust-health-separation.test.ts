/**
 * V2-004 — Node trust, health and assurance separation.
 *
 * Proves (constitution §21: "Node identity, workload identity, capability
 * possession, authorization, placement, policy, cryptographic authenticity,
 * assurance, observed effect, and verification remain separate dimensions";
 * work order "Must deliver": health/availability and trust attributes):
 *   - unhealthy node conditions (degraded / unavailable) are represented
 *     explicitly and make the step ineligible (`capability_unhealthy`);
 *   - untrusted node conditions are explicit (`trust_unverified`);
 *   - assurance floors reject weaker and absent assurance
 *     (`assurance_below_floor`) — absence is never silently downgraded or
 *     emulated (constitution §21);
 *   - trust and health never substitute for each other or for capability;
 *   - each dimension fails exactly with its own reason (no contamination).
 */
import { describe, it, expect } from 'vitest';
import type { AssuranceLevel } from '../../../src/node-capability/index.js';
import {
  advertisement,
  authorization,
  makeService,
  registerFixtureNode,
  step,
  workflowRequest,
} from './helpers.js';

const WORKFLOW_REF = 'workflow-version:fixture:trust@1';

function evaluateTrust(
  advertisementOverrides: Parameters<typeof advertisement>[2],
  stepOverrides: Parameters<typeof step>[2] = {},
) {
  const service = makeService(['trust-node']);
  const { nodeId } = registerFixtureNode(service, 'trust-node', {
    advertisements: [advertisement('filesystem.read', ['deterministic_api'], advertisementOverrides)],
  });
  const evaluation = service.evaluateNode(
    nodeId,
    workflowRequest([step('read', 'filesystem.read', stepOverrides)], WORKFLOW_REF),
    authorization('authorized', WORKFLOW_REF),
  );
  return evaluation.steps[0]!;
}

describe('V2-004 — health is an explicit dimension', () => {
  it('a healthy node is eligible', () => {
    expect(evaluateTrust({}).eligible).toBe(true);
  });

  it('a degraded node is explicitly ineligible with the health recorded', () => {
    const decision = evaluateTrust({ health: 'degraded' });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['capability_unhealthy']);
    expect(decision.advertised?.health).toBe('degraded');
  });

  it('an unavailable node is explicitly ineligible with the health recorded', () => {
    const decision = evaluateTrust({ health: 'unavailable' });
    expect(decision.reasons).toEqual(['capability_unhealthy']);
    expect(decision.advertised?.health).toBe('unavailable');
  });
});

describe('V2-004 — node trust is an explicit dimension', () => {
  it('an unverified node is ineligible (trust_unverified)', () => {
    const decision = evaluateTrust({ trust: { trustLevel: 'unverified', assurance: 'software_signed' } });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['trust_unverified']);
  });

  it('verified and trusted nodes pass the trust dimension', () => {
    expect(
      evaluateTrust({ trust: { trustLevel: 'verified', assurance: null } }).reasons,
    ).toEqual([]);
    expect(
      evaluateTrust({ trust: { trustLevel: 'trusted', assurance: 'software_signed' } }).reasons,
    ).toEqual([]);
  });

  it('trust is per-capability advertisement state, not a blanket node fact', () => {
    const service = makeService(['trust-per-capability']);
    const { nodeId } = registerFixtureNode(service, 'trust-per-capability', {
      advertisements: [
        advertisement('filesystem.read', ['deterministic_api'], {
          trust: { trustLevel: 'unverified', assurance: null },
        }),
        advertisement('browser.observe', ['deterministic_api'], {
          trust: { trustLevel: 'verified', assurance: 'software_signed' },
        }),
      ],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([step('read', 'filesystem.read'), step('observe', 'browser.observe')], WORKFLOW_REF),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps.map((s) => s.eligible)).toEqual([false, true]);
    expect(evaluation.steps[0]?.reasons).toEqual(['trust_unverified']);
  });
});

describe('V2-004 — assurance floors (evidence/trust property, not execution class)', () => {
  const FLOOR_STEP = {
    assuranceFloor: 'hardware_backed' as AssuranceLevel,
  };

  it('a node below the assurance floor is ineligible (assurance_below_floor)', () => {
    const decision = evaluateTrust(
      { trust: { trustLevel: 'verified', assurance: 'software_signed' } },
      FLOOR_STEP,
    );
    expect(decision.reasons).toEqual(['assurance_below_floor']);
  });

  it('a node with NO assurance is explicitly below the floor — absence is never silently accepted', () => {
    const decision = evaluateTrust({ trust: { trustLevel: 'verified', assurance: null } }, FLOOR_STEP);
    expect(decision.reasons).toEqual(['assurance_below_floor']);
    expect(decision.advertised?.trust.assurance).toBeNull();
  });

  it('a node at or above the floor passes (hardware_backed, tee_attested)', () => {
    for (const assurance of ['hardware_backed', 'tee_attested', 'verifiable_computation'] as const) {
      expect(evaluateTrust({ trust: { trustLevel: 'verified', assurance } }, FLOOR_STEP).reasons).toEqual([]);
    }
  });

  it('without a floor, explicit assurance absence is honest and non-blocking', () => {
    const decision = evaluateTrust({ trust: { trustLevel: 'verified', assurance: null } });
    expect(decision.eligible).toBe(true);
    expect(decision.advertised?.trust.assurance).toBeNull();
  });
});

describe('V2-004 — the five eligibility dimensions stay separate', () => {
  it('each single failing dimension produces exactly its own reason', () => {
    // capability
    {
      const service = makeService(['dim-capability']);
      const { nodeId } = registerFixtureNode(service, 'dim-capability', {
        advertisements: [advertisement('browser.observe', ['deterministic_api'])],
      });
      const [decision] = service
        .evaluateNode(
          nodeId,
          workflowRequest([step('read', 'filesystem.read')], WORKFLOW_REF),
          authorization('authorized', WORKFLOW_REF),
        )
        .steps;
      expect(decision?.reasons).toEqual(['capability_missing']);
    }
    // health
    expect(evaluateTrust({ health: 'degraded' }).reasons).toEqual(['capability_unhealthy']);
    // trust
    expect(evaluateTrust({ trust: { trustLevel: 'unverified', assurance: null } }).reasons).toEqual([
      'trust_unverified',
    ]);
    // assurance
    expect(
      evaluateTrust(
        { trust: { trustLevel: 'verified', assurance: 'software_signed' } },
        { assuranceFloor: 'hardware_backed' },
      ).reasons,
    ).toEqual(['assurance_below_floor']);
    // authorization
    {
      const service = makeService(['dim-authz']);
      const { nodeId } = registerFixtureNode(service, 'dim-authz', {
        advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
      });
      const [decision] = service
        .evaluateNode(nodeId, workflowRequest([step('read', 'filesystem.read')], WORKFLOW_REF), null)
        .steps;
      expect(decision?.reasons).toEqual(['authorization_missing']);
    }
    // placement
    {
      const service = makeService(['dim-placement']);
      const { nodeId } = registerFixtureNode(service, 'dim-placement', {
        platformClass: 'cloud',
        advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
      });
      const [decision] = service
        .evaluateNode(
          nodeId,
          workflowRequest([step('read', 'filesystem.read', { placement: 'device_local' })], WORKFLOW_REF),
          authorization('authorized', WORKFLOW_REF),
        )
        .steps;
      expect(decision?.reasons).toEqual(['placement_forbidden']);
    }
  });

  it('trust, assurance, health and authorization failing together lists every dimension', () => {
    const service = makeService(['dim-all']);
    const { nodeId } = registerFixtureNode(service, 'dim-all', {
      advertisements: [
        advertisement('filesystem.read', ['deterministic_api'], {
          health: 'unavailable',
          trust: { trustLevel: 'unverified', assurance: null },
        }),
      ],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest(
        [
          step('read', 'filesystem.read', {
            assuranceFloor: 'software_signed',
            placement: 'device_local',
          }),
        ],
        WORKFLOW_REF,
      ),
      authorization('denied', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.reasons).toEqual([
      'capability_unhealthy',
      'trust_unverified',
      'assurance_below_floor',
      'authorization_denied',
    ]);
  });
});

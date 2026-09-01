/**
 * V2-004 — Capability requirement matching.
 *
 * Proves (work order "Must deliver": capability requirement matching separated
 * from authorization; constitution §5/§6):
 *   - a supported capability with satisfied constraints yields an explicit
 *     eligible result;
 *   - an UNSUPPORTED capability yields an explicit ineligible result with
 *     reason `capability_missing` — never an emulation or substitution;
 *   - an execution class the node does not support for an advertised
 *     capability is an explicit `execution_class_unsupported` result;
 *   - fallback execution classes are only honored when the workflow
 *     EXPLICITLY declares them, and the decision records that the fallback
 *     was used (never silently);
 *   - a deterministic_api step is never silently downgraded to
 *     agentic_computer_use when no fallback was declared (and vice versa);
 *   - multiple failed dimensions accumulate in a deterministic canonical
 *     order.
 */
import { describe, it, expect } from 'vitest';
import {
  advertisement,
  authorization,
  CLOUD_POSTURE,
  makeService,
  registerFixtureNode,
  step,
  workflowRequest,
} from './helpers.js';

const WORKFLOW_REF = 'workflow-version:fixture:matching@1';

describe('V2-004 — capability requirement matching', () => {
  it('a supported capability with satisfied constraints is eligible', () => {
    const service = makeService(['match-ok']);
    const { nodeId } = registerFixtureNode(service, 'match-ok', {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([step('read-config', 'filesystem.read')], WORKFLOW_REF),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.workflowEligible).toBe(true);
    const decision = evaluation.steps[0]!;
    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.advertised?.capability).toBe('filesystem.read');
    expect(decision.resolvedExecutionClass).toBe('deterministic_api');
    expect(decision.viaDeclaredFallback).toBe(false);
    // any_supported_node on a device-class node is the neutral tier — the
    // placement suite pins the same value for the identical scenario.
    expect(decision.placementTier).toBe('neutral');
  });

  it('an unsupported capability is an explicit ineligible result (capability_missing)', () => {
    const service = makeService(['match-missing']);
    const { nodeId } = registerFixtureNode(service, 'match-missing', {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([step('answer-call', 'phone.call.answer')], WORKFLOW_REF),
      authorization('authorized', WORKFLOW_REF),
    );
    const decision = evaluation.steps[0]!;
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['capability_missing']);
    expect(decision.advertised).toBeNull();
    expect(evaluation.workflowEligible).toBe(false);
  });

  it('a node advertising a sibling capability does NOT satisfy a missing one (no substitution)', () => {
    // The web host advertises browser.download but NOT filesystem.read — it
    // must not emulate local file reads through the browser.
    const service = makeService(['match-no-substitute']);
    const { nodeId } = registerFixtureNode(service, 'match-no-substitute', {
      advertisements: [advertisement('browser.download', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([step('read-local-file', 'filesystem.read')], WORKFLOW_REF),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.reasons).toEqual(['capability_missing']);
  });

  it('an execution class the node does not support is explicit (execution_class_unsupported)', () => {
    const service = makeService(['match-class']);
    const { nodeId } = registerFixtureNode(service, 'match-class', {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([step('agentic-read', 'filesystem.read', { executionClass: 'agentic_computer_use' })], WORKFLOW_REF),
      authorization('authorized', WORKFLOW_REF),
    );
    const decision = evaluation.steps[0]!;
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['execution_class_unsupported']);
    // The capability IS advertised — the class is the explicit failure.
    expect(decision.advertised?.capability).toBe('filesystem.read');
    expect(decision.resolvedExecutionClass).toBeNull();
  });

  it('a DECLARED fallback execution class is honored and recorded (never silent)', () => {
    const service = makeService(['match-fallback']);
    const { nodeId } = registerFixtureNode(service, 'match-fallback', {
      advertisements: [advertisement('application.interact', ['agentic_computer_use'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([
        step('interact-app', 'application.interact', {
          executionClass: 'deterministic_api',
          fallbackExecutionClasses: ['agentic_computer_use'],
        }),
      ], WORKFLOW_REF),
      authorization('authorized', WORKFLOW_REF),
    );
    const decision = evaluation.steps[0]!;
    expect(decision.eligible).toBe(true);
    expect(decision.resolvedExecutionClass).toBe('agentic_computer_use');
    expect(decision.viaDeclaredFallback).toBe(true);
  });

  it('no undeclared substitution: deterministic_api never silently becomes computer-use', () => {
    const service = makeService(['match-no-fallback']);
    const { nodeId } = registerFixtureNode(service, 'match-no-fallback', {
      advertisements: [advertisement('application.interact', ['agentic_computer_use'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([
        step('interact-app', 'application.interact', { executionClass: 'deterministic_api' }),
      ], WORKFLOW_REF),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.eligible).toBe(false);
    expect(evaluation.steps[0]?.resolvedExecutionClass).toBeNull();
    expect(evaluation.workflowEligible).toBe(false);
  });

  it('no reverse substitution either: agentic never silently becomes deterministic_api', () => {
    const service = makeService(['match-no-reverse']);
    const { nodeId } = registerFixtureNode(service, 'match-no-reverse', {
      advertisements: [advertisement('application.interact', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([
        step('interact-app', 'application.interact', { executionClass: 'agentic_computer_use' }),
      ], WORKFLOW_REF),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.reasons).toEqual(['execution_class_unsupported']);
  });

  it('a declared fallback that the node still cannot satisfy stays ineligible', () => {
    const service = makeService(['match-fallback-missing']);
    const { nodeId } = registerFixtureNode(service, 'match-fallback-missing', {
      advertisements: [advertisement('application.interact', ['human'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([
        step('interact-app', 'application.interact', {
          executionClass: 'deterministic_api',
          fallbackExecutionClasses: ['agentic_computer_use'],
        }),
      ], WORKFLOW_REF),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.reasons).toEqual(['execution_class_unsupported']);
  });

  it('fallback resolution takes the first declared fallback the node supports (deterministic order)', () => {
    const service = makeService(['match-fallback-order']);
    const { nodeId } = registerFixtureNode(service, 'match-fallback-order', {
      advertisements: [advertisement('application.interact', ['human', 'agentic_computer_use'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([
        step('interact-app', 'application.interact', {
          executionClass: 'deterministic_api',
          fallbackExecutionClasses: ['agentic_computer_use', 'human'],
        }),
      ], WORKFLOW_REF),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.resolvedExecutionClass).toBe('agentic_computer_use');
  });

  it('multiple failed dimensions accumulate in the canonical reason order', () => {
    // Cloud node, missing capability, device_local placement, device_only
    // privacy, denied authorization — every failed dimension is reported,
    // in the protocol's fixed order.
    const service = makeService(['match-multi']);
    const { nodeId } = registerFixtureNode(service, 'match-multi', {
      platformClass: 'cloud',
      // A cloud host must honestly declare its egress posture.
      privacyPosture: CLOUD_POSTURE,
      advertisements: [advertisement('workflow.execute', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([
        step('local-step', 'phone.call.answer', {
          placement: 'device_local',
          privacy: { dataLocality: 'device_only', requiresHumanApproval: false },
        }),
      ], WORKFLOW_REF),
      authorization('denied', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.reasons).toEqual([
      'capability_missing',
      'placement_forbidden',
      'privacy_data_locality',
      'authorization_denied',
    ]);
  });

  it('workflow eligibility requires every step to be eligible', () => {
    const service = makeService(['match-all-steps']);
    const { nodeId } = registerFixtureNode(service, 'match-all-steps', {
      advertisements: [
        advertisement('filesystem.read', ['deterministic_api']),
        advertisement('browser.navigate', ['deterministic_api']),
      ],
    });
    const mixed = service.evaluateNode(
      nodeId,
      workflowRequest(
        [
          step('read', 'filesystem.read'),
          step('call', 'phone.call.answer'), // missing on this host
        ],
        WORKFLOW_REF,
      ),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(mixed.workflowEligible).toBe(false);
    expect(mixed.steps.map((s) => s.eligible)).toEqual([true, false]);

    const allGood = service.evaluateNode(
      nodeId,
      workflowRequest(
        [step('read', 'filesystem.read'), step('navigate', 'browser.navigate')],
        WORKFLOW_REF,
      ),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(allGood.workflowEligible).toBe(true);
  });

  it('evaluation of an unknown node fails closed with node_unknown', () => {
    const service = makeService(['unknown-node']);
    expect(() =>
      service.evaluateNode(
        'node_0000000000000000000000000000000000000000000000000000000000000000',
        workflowRequest([step('read', 'filesystem.read')], WORKFLOW_REF),
        authorization('authorized', WORKFLOW_REF),
      ),
    ).toThrowError(/node_unknown/);
  });
});

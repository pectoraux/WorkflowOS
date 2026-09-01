/**
 * V2-004 — Capability versus authorization discrimination.
 *
 * The core architectural rule (constitution §5, V2-CTRL-003
 * `capability-advertisement-is-not-authorization`):
 *
 *   eligibility = capability availability
 *                 AND workflow policy
 *                 AND user/organization authorization
 *                 AND placement constraints
 *                 AND node trust/health
 *
 * These tests prove that capability possession NEVER grants authorization:
 *   - a node that possesses the capability but has no authorization decision
 *     is explicitly ineligible (`authorization_missing`);
 *   - a denied decision is explicitly ineligible (`authorization_denied`);
 *   - neither node trust, nor assurance, nor health can substitute for
 *     authorization;
 *   - the authorization decision must bind to the workflow it authorizes
 *     (scope mismatch is explicit);
 *   - capability invocation refuses to execute without an explicit
 *     authorization decision — possession alone never executes.
 */
import { describe, it, expect } from 'vitest';
import {
  advertisement,
  authorization,
  makeService,
  registerFixtureNode,
  step,
  workflowRequest,
} from './helpers.js';

const WORKFLOW_REF = 'workflow-version:fixture:authz@1';

describe('V2-004 — capability vs authorization discrimination', () => {
  it('capability possession without an authorization decision is explicitly ineligible', () => {
    const service = makeService(['possession-no-authz']);
    const { nodeId } = registerFixtureNode(service, 'possession-no-authz', {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([step('read', 'filesystem.read')], WORKFLOW_REF),
      null,
    );
    expect(evaluation.steps[0]?.eligible).toBe(false);
    expect(evaluation.steps[0]?.reasons).toEqual(['authorization_missing']);
    expect(evaluation.workflowEligible).toBe(false);
    // The capability itself matched — possession was never in doubt.
    expect(evaluation.steps[0]?.advertised?.capability).toBe('filesystem.read');
  });

  it('a denied authorization decision is explicitly ineligible even with full capability', () => {
    const service = makeService(['possession-denied']);
    const { nodeId } = registerFixtureNode(service, 'possession-denied', {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([step('read', 'filesystem.read')], WORKFLOW_REF),
      authorization('denied', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.reasons).toEqual(['authorization_denied']);
  });

  it('an authorized decision with full capability is eligible', () => {
    const service = makeService(['possession-authorized']);
    const { nodeId } = registerFixtureNode(service, 'possession-authorized', {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([step('read', 'filesystem.read')], WORKFLOW_REF),
      authorization('authorized', WORKFLOW_REF),
    );
    expect(evaluation.steps[0]?.eligible).toBe(true);
  });

  it('an authorization decision bound to a different workflow does not transfer (scope mismatch)', () => {
    const service = makeService(['authz-scope']);
    const { nodeId } = registerFixtureNode(service, 'authz-scope', {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([step('read', 'filesystem.read')], WORKFLOW_REF),
      authorization('authorized', 'workflow-version:fixture:other-workflow@1'),
    );
    expect(evaluation.steps[0]?.reasons).toEqual(['authorization_scope_mismatch']);
  });

  it('node trust never substitutes for authorization (untrusted+trusted both stay ineligible)', () => {
    const service = makeService(['trust-not-authz']);
    const { nodeId } = registerFixtureNode(service, 'trust-not-authz', {
      advertisements: [
        advertisement('filesystem.read', ['deterministic_api'], {
          trust: { trustLevel: 'trusted', assurance: 'hardware_backed' },
        }),
      ],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([step('read', 'filesystem.read')], WORKFLOW_REF),
      null,
    );
    // Capability present, trusted node, strong assurance — still no execution
    // without the user/organization authorization dimension.
    expect(evaluation.steps[0]?.reasons).toEqual(['authorization_missing']);
  });

  it('a healthy node with the capability and a denied decision reports both capability match and denial', () => {
    const service = makeService(['authz-denied-report']);
    const { nodeId } = registerFixtureNode(service, 'authz-denied-report', {
      advertisements: [advertisement('browser.observe', ['deterministic_api'])],
    });
    const evaluation = service.evaluateNode(
      nodeId,
      workflowRequest([step('observe', 'browser.observe')], WORKFLOW_REF),
      authorization('denied', WORKFLOW_REF),
    );
    const [decision] = evaluation.steps;
    expect(decision.advertised?.capability).toBe('browser.observe');
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toEqual(['authorization_denied']);
  });

  it('invocation refuses to execute without an explicit authorization decision', () => {
    const service = makeService(['invoke-no-authz']);
    const { nodeId } = registerFixtureNode(service, 'invoke-no-authz', {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    });
    service.attachHostHandler(nodeId, 'filesystem.read', 'deterministic_api', () => ({
      observed: true,
    }));
    expect(() =>
      service.invokeCapability(nodeId, {
        stepId: 'read',
        capability: 'filesystem.read',
        executionClass: 'deterministic_api',
        input: { path: '/tmp/fixture.txt' },
        authorization: null,
      }),
    ).toThrowError(/authorization_required/);
  });

  it('invocation refuses a denied authorization decision even though the node has the capability', () => {
    const service = makeService(['invoke-denied']);
    const { nodeId } = registerFixtureNode(service, 'invoke-denied', {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    });
    service.attachHostHandler(nodeId, 'filesystem.read', 'deterministic_api', () => ({
      observed: true,
    }));
    expect(() =>
      service.invokeCapability(nodeId, {
        stepId: 'read',
        capability: 'filesystem.read',
        executionClass: 'deterministic_api',
        input: { path: '/tmp/fixture.txt' },
        authorization: authorization('denied', 'filesystem.read'),
      }),
    ).toThrowError(/authorization_denied/);
  });

  it('invocation binds authorization to the capability it authorizes (scope mismatch)', () => {
    const service = makeService(['invoke-scope']);
    const { nodeId } = registerFixtureNode(service, 'invoke-scope', {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    });
    service.attachHostHandler(nodeId, 'filesystem.read', 'deterministic_api', () => ({
      observed: true,
    }));
    expect(() =>
      service.invokeCapability(nodeId, {
        stepId: 'read',
        capability: 'filesystem.read',
        executionClass: 'deterministic_api',
        input: { path: '/tmp/fixture.txt' },
        authorization: authorization('authorized', 'browser.navigate'),
      }),
    ).toThrowError(/authorization_scope_mismatch/);
  });

  it('an authorized invocation executes and records the canonical completion event', () => {
    const service = makeService(['invoke-authorized']);
    const { nodeId } = registerFixtureNode(service, 'invoke-authorized', {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
    });
    service.attachHostHandler(
      nodeId,
      'filesystem.read',
      'deterministic_api',
      () => ({ observed: true, capability: 'filesystem.read' }),
    );
    const record = service.invokeCapability(nodeId, {
      stepId: 'read',
      capability: 'filesystem.read',
      executionClass: 'deterministic_api',
      input: { path: '/tmp/fixture.txt' },
      authorization: authorization('authorized', 'filesystem.read'),
    });
    expect(record.event).toBe('capability.invocation.completed');
    expect(record.evidenceClass).toBe('observation');
    expect(record.nodeId).toBe(nodeId);
    expect(record.capability).toBe('filesystem.read');
    expect(record.executionClass).toBe('deterministic_api');
  });

  it('invocation of an unadvertised capability is an explicit refusal, never an emulation', () => {
    const service = makeService(['invoke-missing']);
    const { nodeId } = registerFixtureNode(service, 'invoke-missing', {
      advertisements: [advertisement('browser.observe', ['deterministic_api'])],
    });
    service.attachHostHandler(nodeId, 'browser.observe', 'deterministic_api', () => ({
      observed: true,
    }));
    expect(() =>
      service.invokeCapability(nodeId, {
        stepId: 'call',
        capability: 'phone.call.answer',
        executionClass: 'deterministic_api',
        input: {},
        authorization: authorization('authorized', 'phone.call.answer'),
      }),
    ).toThrowError(/capability_missing/);
  });

  it('invocation sequence numbers are deterministic and monotonic per node', () => {
    const service = makeService(['invoke-sequence']);
    const { nodeId } = registerFixtureNode(service, 'invoke-sequence', {
      advertisements: [advertisement('browser.observe', ['deterministic_api'])],
    });
    service.attachHostHandler(nodeId, 'browser.observe', 'deterministic_api', () => ({
      observed: true,
    }));
    const invocation = {
      stepId: 'observe',
      capability: 'browser.observe',
      executionClass: 'deterministic_api' as const,
      input: {},
      authorization: authorization('authorized', 'browser.observe'),
    };
    const first = service.invokeCapability(nodeId, invocation);
    const second = service.invokeCapability(nodeId, invocation);
    expect(second.invocationSequence).toBe(first.invocationSequence + 1);
    expect(first.invocationSequence).toBe(1);
  });
});

/**
 * V2-004 — feature-boundary dogfooding experiment (dogfooding-protocol.md).
 *
 * Work Order V2-004 required experiment: "Discover capabilities from two real
 * supported host classes and run the same workflow semantics through both
 * where the required capabilities exist" — and the protocol-level requirement
 * that "a real node's capabilities are discovered and a workflow is executed
 * through capability matching without platform-specific semantics leaking
 * into the workflow".
 *
 * Real product path (no service mocks — the NodeCapabilityService, the
 * authenticated registration protocol, the key directory, HMAC signing,
 * discovery, matching and invocation dispatch are all the real production
 * code under src/node-capability):
 *
 *   - DESKTOP host class node — its filesystem.read host handler performs a
 *     REAL filesystem read (node:fs) of the committed fixture file: a
 *     genuinely executed capability, not a mock.
 *   - WEB host class node — its browser.observe handler is an explicit
 *     boundary adapter placeholder: the real browser runtime adapter is owned
 *     by V2-008 (not yet merged in W1), which the dogfooding protocol
 *     explicitly allows ("a mock is acceptable only for a dependency
 *     explicitly outside the feature's control boundary"). The placeholder is
 *     declared honestly — the web node does NOT claim any capability it
 *     cannot honestly advertise.
 *
 * Expected: the two host classes honestly report DIFFERENT eligibility for
 * the same workflow (the desktop node lacks browser.observe; the web node
 * lacks filesystem.read — neither emulates the other), the shared
 * human-approval step is eligible on both, capability invocation executes
 * only where matching produced an eligible decision, and no
 * platform-specific semantics appear in the workflow semantics (every
 * protocol-visible identifier is registry-canonical).
 *
 * Evidence: spec/architecture/v2/dogfooding-evidence/V2-004-dogfooding.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isCanonicalCapabilityName,
  isCanonicalExecutionClass,
  isCanonicalPlacementConstraint,
  type AuthorizationDecision,
  type HostPlatformClass,
  type NodeCapabilityService,
  type StepCapabilityRequirement,
  type WorkflowExecutionRequest,
} from '../../../src/node-capability/index.js';
import {
  authorization,
  makeService,
  registerFixtureNode,
} from '../../unit/node-capability/helpers.js';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/local-config.json', import.meta.url));
const FIXTURE_BYTES = readFileSync(FIXTURE_PATH, 'utf8');

const WORKFLOW_REF = 'workflow-version:dogfood:two-host@1';

/**
 * The same workflow semantics evaluated on both host classes. Every
 * identifier is registry-canonical; no platform SDK semantics anywhere.
 */
const DOGFOOD_WORKFLOW: WorkflowExecutionRequest = {
  workflowVersionRef: WORKFLOW_REF,
  steps: [
    {
      stepId: 'read-local-config',
      capability: 'filesystem.read',
      executionClass: 'deterministic_api',
      placement: 'device_preferred',
      privacy: { dataLocality: 'device_or_cloud', requiresHumanApproval: false },
    },
    {
      stepId: 'observe-job-page',
      capability: 'browser.observe',
      executionClass: 'deterministic_api',
      placement: 'any_supported_node',
      privacy: { dataLocality: 'device_or_cloud', requiresHumanApproval: false },
    },
    {
      stepId: 'notify-operator',
      capability: 'notifications.observe',
      executionClass: 'human',
      placement: 'any_supported_node',
      privacy: { dataLocality: 'device_or_cloud', requiresHumanApproval: true },
    },
  ],
};

interface HostNode {
  hostClass: HostPlatformClass;
  service: NodeCapabilityService;
  nodeId: string;
}

function registerDesktopHost(): HostNode {
  const service = makeService(['dogfood-desktop-host']);
  const { nodeId } = registerFixtureNode(service, 'dogfood-desktop-host', {
    platformClass: 'desktop',
    advertisements: [
      {
        capability: 'filesystem.read',
        capabilityVersion: 1,
        executionClasses: ['deterministic_api'],
        health: 'healthy',
        trust: { trustLevel: 'verified', assurance: 'software_signed' },
      },
      {
        capability: 'notifications.observe',
        capabilityVersion: 1,
        executionClasses: ['human', 'deterministic_api'],
        health: 'healthy',
        trust: { trustLevel: 'verified', assurance: 'software_signed' },
      },
    ],
    privacyPosture: {
      supportsHumanApproval: true,
      cloudEgress: 'none',
      secretDelivery: 'opaque_reference_only',
    },
  });
  // REAL capability execution: the desktop host genuinely reads the fixture
  // file from disk through node:fs.
  service.attachHostHandler(nodeId, 'filesystem.read', 'deterministic_api', (input) => {
    const path = typeof input === 'object' && input !== null && 'path' in input
      ? String((input as { path: unknown }).path)
      : FIXTURE_PATH;
    return { content: readFileSync(path, 'utf8') };
  });
  // notifications.observe: boundary adapter (the desktop notification surface
  // is an OS adapter owned by later execution-runtime work).
  service.attachHostHandler(nodeId, 'notifications.observe', 'human', () => ({
    acknowledged: true,
  }));
  return { hostClass: 'desktop', service, nodeId };
}

function registerWebHost(): HostNode {
  const service = makeService(['dogfood-web-host']);
  const { nodeId } = registerFixtureNode(service, 'dogfood-web-host', {
    platformClass: 'web',
    advertisements: [
      {
        capability: 'browser.observe',
        capabilityVersion: 1,
        executionClasses: ['deterministic_api'],
        health: 'healthy',
        trust: { trustLevel: 'verified', assurance: 'software_signed' },
      },
      {
        capability: 'notifications.observe',
        capabilityVersion: 1,
        executionClasses: ['human', 'deterministic_api'],
        health: 'healthy',
        trust: { trustLevel: 'verified', assurance: 'software_signed' },
      },
    ],
    privacyPosture: {
      supportsHumanApproval: true,
      cloudEgress: 'allowed',
      secretDelivery: 'opaque_reference_only',
    },
  });
  // browser.observe: explicit V2-008 boundary adapter placeholder — the web
  // host honestly advertises only what the protocol can represent today.
  service.attachHostHandler(nodeId, 'browser.observe', 'deterministic_api', () => ({
    observed: true,
    surface: 'web',
  }));
  service.attachHostHandler(nodeId, 'notifications.observe', 'human', () => ({
    acknowledged: true,
  }));
  return { hostClass: 'web', service, nodeId };
}

function discoverEligibility(host: HostNode): boolean[] {
  const evaluation = host.service.evaluateNode(
    host.nodeId,
    DOGFOOD_WORKFLOW,
    authorization('authorized', WORKFLOW_REF),
  );
  return evaluation.steps.map((decision) => decision.eligible);
}

describe('V2-004 dogfood — two real host classes, one workflow semantics', () => {
  it('both host classes register through the authenticated protocol and are discoverable', () => {
    const desktop = registerDesktopHost();
    const web = registerWebHost();
    for (const host of [desktop, web]) {
      const discovered = host.service
        .discoverNodes()
        .find((descriptor) => descriptor.nodeId === host.nodeId);
      expect(discovered, `${host.hostClass} node must be discoverable`).toBeDefined();
      expect(discovered!.platformClass).toBe(host.hostClass);
      expect(discovered!.capabilities.length).toBe(2);
      for (const capability of discovered!.capabilities) {
        expect(isCanonicalCapabilityName(capability.capability)).toBe(true);
      }
    }
  });

  it('the two host classes honestly report DIFFERENT eligibility for the same workflow', () => {
    const desktop = discoverEligibility(registerDesktopHost());
    const web = discoverEligibility(registerWebHost());
    expect(desktop).toEqual([true, false, true]); // desktop lacks browser.observe
    expect(web).toEqual([false, true, true]); // web lacks filesystem.read
    expect(desktop).not.toEqual(web);
  });

  it('neither host class is fully eligible — the honest partial answer, never silent emulation', () => {
    for (const register of [registerDesktopHost, registerWebHost]) {
      const host = register();
      const evaluation = host.service.evaluateNode(
        host.nodeId,
        DOGFOOD_WORKFLOW,
        authorization('authorized', WORKFLOW_REF),
      );
      expect(evaluation.workflowEligible).toBe(false);
    }
  });

  it('no platform-specific semantics leak into the workflow (all identifiers registry-canonical)', () => {
    for (const workflowStep of DOGFOOD_WORKFLOW.steps as StepCapabilityRequirement[]) {
      expect(isCanonicalCapabilityName(workflowStep.capability)).toBe(true);
      expect(isCanonicalExecutionClass(workflowStep.executionClass)).toBe(true);
      expect(isCanonicalPlacementConstraint(workflowStep.placement)).toBe(true);
    }
    const serialized = JSON.stringify(DOGFOOD_WORKFLOW);
    expect(serialized).not.toMatch(/electron|cocoa|uiautomation|accessibility|xpath|css-selector/i);
  });

  it('the shared human-approval step is eligible on both host classes with equivalent decisions', () => {
    const decisions = [registerDesktopHost(), registerWebHost()].map((host) => {
      const evaluation = host.service.evaluateNode(
        host.nodeId,
        DOGFOOD_WORKFLOW,
        authorization('authorized', WORKFLOW_REF),
      );
      return evaluation.steps.find((decision) => decision.stepId === 'notify-operator')!;
    });
    for (const decision of decisions) {
      expect(decision.eligible).toBe(true);
      expect(decision.reasons).toEqual([]);
      expect(decision.resolvedExecutionClass).toBe('human');
    }
  });

  it('the desktop host executes its matched filesystem.read step against the REAL filesystem', () => {
    const desktop = registerDesktopHost();
    const record = desktop.service.invokeCapability(desktop.nodeId, {
      stepId: 'read-local-config',
      capability: 'filesystem.read',
      executionClass: 'deterministic_api',
      input: { path: FIXTURE_PATH },
      authorization: authorization('authorized', 'filesystem.read'),
    });
    expect(record.event).toBe('capability.invocation.completed');
    expect(record.evidenceClass).toBe('observation');
    const output = record.output as { content: string };
    expect(output.content).toBe(FIXTURE_BYTES); // the real file bytes came back
  });

  it('the web host executes its matched browser.observe step through the declared boundary adapter', () => {
    const web = registerWebHost();
    const record = web.service.invokeCapability(web.nodeId, {
      stepId: 'observe-job-page',
      capability: 'browser.observe',
      executionClass: 'deterministic_api',
      input: {},
      authorization: authorization('authorized', 'browser.observe'),
    });
    expect(record.event).toBe('capability.invocation.completed');
    expect(record.evidenceClass).toBe('observation');
  });

  it('invocation refuses the steps a host did NOT match (no cross-host substitution)', () => {
    const desktop = registerDesktopHost();
    const web = registerWebHost();
    expect(() =>
      desktop.service.invokeCapability(desktop.nodeId, {
        stepId: 'observe-job-page',
        capability: 'browser.observe',
        executionClass: 'deterministic_api',
        input: {},
        authorization: authorization('authorized', 'browser.observe'),
      }),
    ).toThrowError(/capability_missing/);
    expect(() =>
      web.service.invokeCapability(web.nodeId, {
        stepId: 'read-local-config',
        capability: 'filesystem.read',
        executionClass: 'deterministic_api',
        input: { path: FIXTURE_PATH },
        authorization: authorization('authorized', 'filesystem.read'),
      }),
    ).toThrowError(/capability_missing/);
  });

  it('discovery is deterministic: repeated evaluation yields byte-identical decisions', () => {
    const host = registerDesktopHost();
    const auth: AuthorizationDecision = authorization('authorized', WORKFLOW_REF);
    const first = JSON.stringify(host.service.evaluateNode(host.nodeId, DOGFOOD_WORKFLOW, auth));
    const second = JSON.stringify(host.service.evaluateNode(host.nodeId, DOGFOOD_WORKFLOW, auth));
    expect(first).toBe(second);
  });
});

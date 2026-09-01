/**
 * V2-004 — Protocol boundary hardening (battery extension).
 *
 * The inherited 9-file battery covers the work order's REQUIRED DISCRIMINATION
 * list. This extension closes the remaining gaps so the change surface stays
 * honest at its own boundary:
 *   - the implementation tree imports NOTHING outside itself (no V1 module
 *     internals, no sibling surfaces, no platform SDKs) — the V1 boundary is
 *     consumed through zero imports here, which is the strictest form of the
 *     "public contracts only" rule (constitution §18);
 *   - evaluation fails closed on non-canonical protocol-visible identifiers
 *     in workflow steps (registry aliases never reach the decision engine);
 *   - node identity integrity is symmetric: a key may re-bind neither its
 *     platform class NOR its owner principal;
 *   - discovery is deterministic across nodes, not just within one;
 *   - the invocation gate enforces the full eligibility conjunction: no
 *     handler, unhealthy or untrusted advertisements refuse to execute;
 *   - registration validates duplicate capability advertisements and
 *     non-positive sequences, and the HMAC covers the protocol version.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NodeCapabilityProtocolError,
  type NodeCapabilityService,
} from '../../../src/node-capability/index.js';
import {
  advertisement,
  authorization,
  buildRegistration,
  makeService,
  registerFixtureNode,
  step,
  workflowRequest,
} from './helpers.js';

const BACKEND_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MODULE_ROOT = join(BACKEND_ROOT, 'src', 'node-capability');

/** Recursively yield every `.ts` file under `dir`. */
function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTs(full);
    } else if (entry.endsWith('.ts')) {
      yield full;
    }
  }
}

const WORKFLOW_REF = 'workflow-version:fixture:boundary@1';

describe('V2-004 — implementation tree import discipline (constitution §18)', () => {
  it('src/node-capability exists and exposes a public index', () => {
    expect(statSync(MODULE_ROOT).isDirectory()).toBe(true);
    expect(statSync(join(MODULE_ROOT, 'index.ts')).isFile()).toBe(true);
  });

  it('implementation files import only within the tree or node builtins (no V1, no siblings, no SDKs)', () => {
    const files = [...walkTs(MODULE_ROOT)];
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const specifier of specifiers) {
        const insideTree = specifier.startsWith('.') || specifier.startsWith('node:');
        expect(
          insideTree,
          `${file} imports "${specifier}" — the node-capability tree must be self-contained (V1 consumed only through explicit public contracts; this work order consumes none)`,
        ).toBe(true);
      }
    }
  });
});

describe('V2-004 — evaluation fails closed on non-canonical step identifiers', () => {
  it('a workflow step with a non-canonical capability is rejected at evaluation', () => {
    const service = makeService(['boundary-alias-cap']);
    const { nodeId } = registerFixtureNode(service, 'boundary-alias-cap');
    expect(() =>
      service.evaluateNode(
        nodeId,
        workflowRequest([step('alias', 'messages.send')], WORKFLOW_REF),
        authorization('authorized', WORKFLOW_REF),
      ),
    ).toThrowError(/invalid_capability_name/);
  });

  it('a workflow step with a non-canonical placement is rejected at evaluation', () => {
    const service = makeService(['boundary-alias-placement']);
    const { nodeId } = registerFixtureNode(service, 'boundary-alias-placement');
    expect(() =>
      service.evaluateNode(
        nodeId,
        workflowRequest([step('local', 'filesystem.read', { placement: 'local_only' as never })], WORKFLOW_REF),
        authorization('authorized', WORKFLOW_REF),
      ),
    ).toThrowError(/invalid_placement_constraint/);
  });

  it('a workflow step with a non-canonical execution class is rejected at evaluation', () => {
    const service = makeService(['boundary-alias-class']);
    const { nodeId } = registerFixtureNode(service, 'boundary-alias-class');
    expect(() =>
      service.evaluateNode(
        nodeId,
        workflowRequest([step('api', 'filesystem.read', { executionClass: 'api' as never })], WORKFLOW_REF),
        authorization('authorized', WORKFLOW_REF),
      ),
    ).toThrowError(/invalid_execution_class/);
  });
});

describe('V2-004 — identity integrity is symmetric across identity inputs', () => {
  it('a key may not re-bind its owner principal under the same platform class', () => {
    const service = makeService(['owner-rebind']);
    service.registerNode(buildRegistration('owner-rebind'));
    expect(() =>
      service.registerNode(
        buildRegistration('owner-rebind', {
          registrationSequence: 2,
          ownerPrincipal: 'user:attacker',
        }),
      ),
    ).toThrowError(/invalid_registration/);
  });

  it('registration validation rejects duplicate capability advertisements in one message', () => {
    const service = makeService(['dup-ad']);
    expect(() =>
      service.registerNode(
        buildRegistration('dup-ad', {
          advertisements: [
            advertisement('filesystem.read', ['deterministic_api']),
            advertisement('filesystem.read', ['deterministic_api', 'agentic_computer_use'], {
              capabilityVersion: 2,
            }),
          ],
        }),
      ),
    ).toThrowError(/invalid_registration/);
  });

  it('registration validation rejects non-positive registration sequences', () => {
    const service = makeService(['zero-seq']);
    expect(() =>
      service.registerNode(buildRegistration('zero-seq', { registrationSequence: 0 })),
    ).toThrowError(/invalid_registration/);
  });

  it('the registration HMAC covers the protocol version (tampering it fails authentication)', () => {
    const service = makeService(['tamper-version']);
    const request = buildRegistration('tamper-version');
    const tampered: typeof request = { ...request, protocolVersion: '9.9' };
    expect(() => service.registerNode(tampered)).toThrowError(/node_authentication_failed/);
  });
});

describe('V2-004 — the invocation gate enforces the full eligibility conjunction', () => {
  function preparedService(
    keySeed: string,
    overrides: Parameters<typeof advertisement>[2] = {},
  ): { service: NodeCapabilityService; nodeId: string } {
    const service = makeService([keySeed]);
    const { nodeId } = registerFixtureNode(service, keySeed, {
      advertisements: [advertisement('filesystem.read', ['deterministic_api'], overrides)],
    });
    service.attachHostHandler(nodeId, 'filesystem.read', 'deterministic_api', () => ({
      observed: true,
    }));
    return { service, nodeId };
  }

  function invoke(service: NodeCapabilityService, nodeId: string) {
    return () =>
      service.invokeCapability(nodeId, {
        stepId: 'read',
        capability: 'filesystem.read',
        executionClass: 'deterministic_api',
        input: { path: '/tmp/fixture.txt' },
        authorization: authorization('authorized', 'filesystem.read'),
      });
  }

  it('an advertised capability with NO host handler refuses to execute (fail closed)', () => {
    const service = makeService(['no-handler']);
    const { nodeId } = registerFixtureNode(service, 'no-handler');
    expect(invoke(service, nodeId)).toThrowError(/capability_execution_unavailable/);
  });

  it('a degraded advertisement refuses to execute even when authorized', () => {
    const { service, nodeId } = preparedService('invoke-degraded', { health: 'degraded' });
    expect(invoke(service, nodeId)).toThrowError(/capability_unhealthy/);
  });

  it('an untrusted advertisement refuses to execute even when authorized', () => {
    const { service, nodeId } = preparedService('invoke-untrusted', {
      trust: { trustLevel: 'unverified', assurance: 'software_signed' },
    });
    expect(invoke(service, nodeId)).toThrowError(/trust_unverified/);
  });

  it('an execution class the advertisement does not support refuses to execute', () => {
    const service = makeService(['invoke-class']);
    const { nodeId } = registerFixtureNode(service, 'invoke-class');
    expect(() =>
      service.invokeCapability(nodeId, {
        stepId: 'read',
        capability: 'filesystem.read',
        executionClass: 'agentic_computer_use',
        input: { path: '/tmp/fixture.txt' },
        authorization: authorization('authorized', 'filesystem.read'),
      }),
    ).toThrowError(/execution_class_unsupported/);
  });

  it('attaching a handler for a non-canonical capability is rejected', () => {
    const service = makeService(['attach-alias']);
    const { nodeId } = registerFixtureNode(service, 'attach-alias');
    expect(() =>
      service.attachHostHandler(nodeId, 'calls.answer' as string, 'deterministic_api', () => ({})),
    ).toThrowError(/invalid_capability_name/);
  });
});

describe('V2-004 — discovery determinism across nodes', () => {
  it('discoverNodes returns nodes in stable nodeId order across repeated calls', () => {
    const service = makeService(['zeta-node', 'alpha-node', 'mid-node']);
    registerFixtureNode(service, 'zeta-node');
    registerFixtureNode(service, 'alpha-node');
    registerFixtureNode(service, 'mid-node');
    const first = service.discoverNodes().map((d) => d.nodeId);
    const second = service.discoverNodes().map((d) => d.nodeId);
    expect(second).toEqual(first);
    expect([...first]).toEqual([...first].sort());
    expect(first).toHaveLength(3);
  });
});

describe('V2-004 — typed protocol error surface', () => {
  it('NodeCapabilityProtocolError carries a stable machine-readable code', () => {
    const error = new NodeCapabilityProtocolError('invalid_capability_name', 'detail');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('invalid_capability_name');
    expect(error.code).toBe('invalid_capability_name');
  });
});

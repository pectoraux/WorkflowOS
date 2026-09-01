/**
 * V2-004 — Node identity.
 *
 * Proves (work order "Must deliver": authenticated Node identity and platform
 * class):
 *   - node ids are deterministic and derived only from authoritative identity
 *     inputs (node key fingerprint + owner principal + platform class) — never
 *     from capabilities, session state or random material;
 *   - node identity is STABLE across capability changes (identity ≠
 *     advertisement);
 *   - registration is authenticated: a valid HMAC over the canonical payload
 *     is accepted; a bad HMAC or an unknown key fails closed;
 *   - host key material never appears in protocol payloads or descriptors;
 *   - protocol-version mismatch is an explicit registration rejection.
 */
import { describe, it, expect } from 'vitest';
import {
  computeNodeId,
  createNodeCapabilityService,
  NodeCapabilityProtocolError,
  signRegistrationPayload,
  CURRENT_PROTOCOL_VERSION,
  type NodeIdentityInputs,
} from '../../../src/node-capability/index.js';
import {
  advertisement,
  buildRegistration,
  DEVICE_LOCAL_POSTURE,
  makeKeyDirectory,
  makeNodeKeyMaterial,
  makeService,
} from './helpers.js';

const IDENTITY_INPUTS: NodeIdentityInputs = {
  keyFingerprint: makeNodeKeyMaterial('identity-a').fingerprint,
  ownerPrincipal: 'user:fixture-operator',
  platformClass: 'desktop',
};

function identityInputs(
  overrides: Partial<NodeIdentityInputs> = {},
): NodeIdentityInputs {
  return { ...IDENTITY_INPUTS, ...overrides };
}

describe('V2-004 — node identity', () => {
  it('node ids are deterministic: same identity inputs → identical id (twice, two call sites)', () => {
    const first = computeNodeId(identityInputs());
    const second = computeNodeId(identityInputs());
    expect(first).toBe(second);
  });

  it('node ids follow the stable node_<sha256-hex> format', () => {
    expect(computeNodeId(identityInputs())).toMatch(/^node_[0-9a-f]{64}$/);
  });

  it('different key material → different node id', () => {
    const other = identityInputs({
      keyFingerprint: makeNodeKeyMaterial('identity-b').fingerprint,
    });
    expect(computeNodeId(other)).not.toBe(computeNodeId(identityInputs()));
  });

  it('different platform class → different node id', () => {
    expect(computeNodeId(identityInputs({ platformClass: 'ios' }))).not.toBe(
      computeNodeId(identityInputs()),
    );
  });

  it('different owner principal → different node id', () => {
    expect(computeNodeId(identityInputs({ ownerPrincipal: 'user:other-operator' }))).not.toBe(
      computeNodeId(identityInputs()),
    );
  });

  it('node identity is stable when capabilities change (re-registration with more capabilities)', () => {
    const service = makeService(['stable-node']);
    const first = service.registerNode(
      buildRegistration('stable-node', {
        advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
      }),
    );
    const second = service.registerNode(
      buildRegistration('stable-node', {
        registrationSequence: 2,
        advertisements: [
          advertisement('filesystem.read', ['deterministic_api']),
          advertisement('filesystem.write', ['deterministic_api']),
          advertisement('phone.call.answer', ['deterministic_api']),
        ],
      }),
    );
    expect(second.nodeId).toBe(first.nodeId);
    // Identity does not absorb the capability set: the descriptor does.
    expect(second.capabilities.map((c) => c.capability)).toEqual([
      'filesystem.read',
      'filesystem.write',
      'phone.call.answer',
    ]);
  });

  it('a node may not re-bind its platform class under the same key (identity stability, fail closed)', () => {
    const service = makeService(['identity-stability']);
    service.registerNode(buildRegistration('identity-stability'));
    expect(() =>
      service.registerNode(
        buildRegistration('identity-stability', {
          registrationSequence: 2,
          platformClass: 'cloud',
          privacyPosture: {
            supportsHumanApproval: false,
            cloudEgress: 'allowed',
            secretDelivery: 'opaque_reference_only',
          },
        }),
      ),
    ).toThrowError(/invalid_registration/);
  });

  it('registration with a valid HMAC is accepted', () => {
    const service = makeService(['auth-ok']);
    const descriptor = service.registerNode(buildRegistration('auth-ok'));
    expect(descriptor.platformClass).toBe('desktop');
    expect(descriptor.protocolVersion).toBe(CURRENT_PROTOCOL_VERSION);
    expect(descriptor.keyFingerprint).toBe(makeNodeKeyMaterial('auth-ok').fingerprint);
  });

  it('registration with a wrong HMAC fails closed with node_authentication_failed', () => {
    const service = makeService(['auth-bad']);
    const request = buildRegistration('auth-bad');
    const tampered: typeof request = {
      ...request,
      ownerPrincipal: 'user:attacker', // payload mutated after signing
    };
    expect(() => service.registerNode(tampered)).toThrowError(/node_authentication_failed/);
    expect(() => service.registerNode(tampered)).toThrowError(NodeCapabilityProtocolError);
    // Nothing was registered — fail closed means no partial state.
    expect(service.discoverNodes()).toHaveLength(0);
  });

  it('registration with an unknown key fingerprint fails closed with unknown_node_key', () => {
    const service = createNodeCapabilityService({ keyDirectory: makeKeyDirectory([{ seed: 'known' }]) });
    const request = buildRegistration('unknown-key');
    expect(() => service.registerNode(request)).toThrowError(/unknown_node_key/);
    expect(service.discoverNodes()).toHaveLength(0);
  });

  it('host key material never appears in protocol payloads or discovery descriptors', () => {
    const service = makeService(['secret-hygiene']);
    const request = buildRegistration('secret-hygiene');
    service.registerNode(request);
    const payloadJson = JSON.stringify(request);
    const { secret } = makeNodeKeyMaterial('secret-hygiene');
    expect(payloadJson).not.toContain(secret);
    const descriptor = service.discoverNodes()[0]!;
    expect(descriptor).toBeDefined();
    expect(JSON.stringify(descriptor)).not.toContain(secret);
  });

  it('a tampered advertisement body (HMAC covers advertisements) is rejected', () => {
    const service = makeService(['auth-ad-tamper']);
    const request = buildRegistration('auth-ad-tamper');
    const tampered: typeof request = {
      ...request,
      advertisements: [
        ...request.advertisements,
        advertisement('browser.navigate', ['deterministic_api']),
      ],
    };
    expect(() => service.registerNode(tampered)).toThrowError(/node_authentication_failed/);
  });

  it('the registration HMAC is deterministic for a fixed payload and secret', () => {
    const { secret } = makeNodeKeyMaterial('deterministic-signing');
    const payload = {
      nodeKeyFingerprint: makeNodeKeyMaterial('deterministic-signing').fingerprint,
      platformClass: 'desktop' as const,
      ownerPrincipal: 'user:fixture-operator',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      registrationSequence: 1,
      advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
      privacyPosture: DEVICE_LOCAL_POSTURE,
    };
    const first = signRegistrationPayload(payload, secret);
    const second = signRegistrationPayload(payload, secret);
    expect(first).toEqual(second);
    expect(first.algorithm).toBe('hmac-sha256');
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('protocol-version mismatch is an explicit registration rejection', () => {
    const service = makeService(['version-mismatch']);
    expect(() =>
      service.registerNode(buildRegistration('version-mismatch', { protocolVersion: '1.0' })),
    ).toThrowError(/protocol_version_mismatch/);
    expect(() =>
      service.registerNode(buildRegistration('version-mismatch', { protocolVersion: '3.0' })),
    ).toThrowError(/protocol_version_mismatch/);
    // A compatible minor version of the same major is accepted.
    expect(() =>
      service.registerNode(buildRegistration('version-mismatch', { protocolVersion: '2.1' })),
    ).not.toThrow();
  });

  it('key fingerprint derivation is deterministic and one-way-looking', () => {
    const { secret, fingerprint } = makeNodeKeyMaterial('fingerprint-check');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).toBe(makeNodeKeyMaterial('fingerprint-check').fingerprint);
    expect(fingerprint).not.toContain(secret);
  });

  it('node identity ignores the registration sequence (id does not churn)', () => {
    const service = makeService(['seq-identity']);
    const first = service.registerNode(buildRegistration('seq-identity'));
    const second = service.registerNode(
      buildRegistration('seq-identity', { registrationSequence: 5 }),
    );
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.registrationSequence).toBe(5);
  });
});

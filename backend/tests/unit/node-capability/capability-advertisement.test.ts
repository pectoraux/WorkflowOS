/**
 * V2-004 — Capability advertisement and versioning.
 *
 * Proves (work order "Must deliver": capability advertisement, versioning,
 * health/availability and trust attributes; "Required regressions": stale
 * node):
 *   - only registry-canonical capability names may be advertised — alias
 *     advertisements fail closed at the protocol boundary;
 *   - advertisement versioning is monotonic per node+capability: replayed
 *     (stale) and conflicting advertisements are rejected;
 *   - registration sequence is monotonic per node: replayed registrations are
 *     rejected as stale;
 *   - health states are explicit and honestly representable;
 *   - trust attributes use canonical assurance identifiers; a host that lacks
 *     stronger assurance reports explicit absence (null), never a fake id;
 *   - privacy postures are validated, and a cloud host must honestly declare
 *     cloud egress.
 */
import { describe, it, expect } from 'vitest';
import {
  advertisement,
  buildRegistration,
  CLOUD_POSTURE,
  DEVICE_LOCAL_POSTURE,
  FIXTURE_TRUST,
  makeService,
  registerFixtureNode,
} from './helpers.js';

describe('V2-004 — capability advertisement and versioning', () => {
  it('advertising a non-canonical capability alias is rejected (fail closed)', () => {
    const service = makeService(['alias-ad']);
    expect(() =>
      service.registerNode(
        buildRegistration('alias-ad', {
          advertisements: [advertisement('phone.answer_call', ['deterministic_api'])],
        }),
      ),
    ).toThrowError(/invalid_capability_name/);
    expect(service.discoverNodes()).toHaveLength(0);
  });

  it('advertising a non-canonical execution class is rejected', () => {
    const service = makeService(['alias-class']);
    expect(() =>
      service.registerNode(
        buildRegistration('alias-class', {
          advertisements: [advertisement('filesystem.read', ['computer_use'])],
        }),
      ),
    ).toThrowError(/invalid_execution_class/);
  });

  it('advertising a non-canonical assurance level is rejected', () => {
    const service = makeService(['alias-assurance']);
    expect(() =>
      service.registerNode(
        buildRegistration('alias-assurance', {
          advertisements: [
            advertisement('filesystem.read', ['deterministic_api'], {
              trust: { trustLevel: 'verified', assurance: 'hardware' as never },
            }),
          ],
        }),
      ),
    ).toThrowError(/invalid_assurance_level/);
  });

  it('a host that lacks stronger assurance reports explicit absence (null), never a fake id', () => {
    const service = makeService(['no-assurance']);
    const descriptor = service.registerNode(
      buildRegistration('no-assurance', {
        advertisements: [
          advertisement('browser.observe', ['deterministic_api'], {
            trust: { trustLevel: 'verified', assurance: null },
          }),
        ],
      }),
    );
    const advertised = descriptor.capabilities[0]!;
    expect(advertised.trust.assurance).toBeNull();
  });

  it('an untruthful cloud host (claims no cloud egress) is rejected', () => {
    const service = makeService(['lying-cloud']);
    expect(() =>
      service.registerNode(
        buildRegistration('lying-cloud', {
          platformClass: 'cloud',
          advertisements: [advertisement('workflow.execute', ['deterministic_api'])],
          privacyPosture: { ...DEVICE_LOCAL_POSTURE, cloudEgress: 'none' },
        }),
      ),
    ).toThrowError(/invalid_privacy_posture/);
    // The honest declaration is accepted.
    expect(() =>
      service.registerNode(
        buildRegistration('lying-cloud', {
          platformClass: 'cloud',
          advertisements: [advertisement('workflow.execute', ['deterministic_api'])],
          privacyPosture: CLOUD_POSTURE,
        }),
      ),
    ).not.toThrow();
  });

  it('a dishonest secret-delivery posture is rejected (opaque reference only)', () => {
    const service = makeService(['bad-secret-posture']);
    expect(() =>
      service.registerNode(
        buildRegistration('bad-secret-posture', {
          advertisements: [advertisement('filesystem.read', ['deterministic_api'])],
          privacyPosture: {
            supportsHumanApproval: true,
            cloudEgress: 'none',
            secretDelivery: 'inline_plaintext' as never,
          },
        }),
      ),
    ).toThrowError(/invalid_privacy_posture/);
  });

  it('capability advertisement versioning: higher versions replace, stale versions are rejected', () => {
    const service = makeService(['versioning']);
    service.registerNode(
      buildRegistration('versioning', {
        advertisements: [
          advertisement('filesystem.read', ['deterministic_api'], { capabilityVersion: 3 }),
        ],
      }),
    );
    // Replaying an OLDER advertisement version is stale.
    expect(() =>
      service.registerNode(
        buildRegistration('versioning', {
          registrationSequence: 2,
          advertisements: [
            advertisement('filesystem.read', ['deterministic_api'], { capabilityVersion: 2 }),
          ],
        }),
      ),
    ).toThrowError(/stale_capability_advertisement/);
    // Replaying the SAME version with IDENTICAL content is an idempotent
    // no-op: re-registration (e.g. a heartbeat, or a capability-set change
    // elsewhere) must not churn unchanged advertisement state. A same-version
    // advertisement with DIFFERENT content is the immutable-version conflict
    // covered below; a LOWER version is the stale replay covered above.
    const idempotent = service.registerNode(
      buildRegistration('versioning', {
        registrationSequence: 3,
        advertisements: [
          advertisement('filesystem.read', ['deterministic_api'], { capabilityVersion: 3 }),
        ],
      }),
    );
    expect(idempotent.capabilities.find((c) => c.capability === 'filesystem.read')).toMatchObject({
      capabilityVersion: 3,
    });
    // A strictly higher version replaces the advertisement.
    const descriptor = service.registerNode(
      buildRegistration('versioning', {
        registrationSequence: 4,
        advertisements: [
          advertisement('filesystem.read', ['deterministic_api'], { capabilityVersion: 4 }),
        ],
      }),
    );
    expect(descriptor.capabilities.find((c) => c.capability === 'filesystem.read')).toMatchObject({
      capabilityVersion: 4,
    });
  });

  it('the same capability version with different content is a conflict (immutable advertisement versions)', () => {
    const service = makeService(['conflict']);
    service.registerNode(
      buildRegistration('conflict', {
        advertisements: [
          advertisement('filesystem.read', ['deterministic_api'], { capabilityVersion: 2 }),
        ],
      }),
    );
    expect(() =>
      service.registerNode(
        buildRegistration('conflict', {
          registrationSequence: 2,
          advertisements: [
            advertisement('filesystem.read', ['deterministic_api', 'agentic_computer_use'], {
              capabilityVersion: 2,
            }),
          ],
        }),
      ),
    ).toThrowError(/capability_advertisement_conflict/);
  });

  it('replayed registration sequence is stale (stale node regression)', () => {
    const service = makeService(['stale-reg']);
    service.registerNode(buildRegistration('stale-reg', { registrationSequence: 7 }));
    expect(() =>
      service.registerNode(buildRegistration('stale-reg', { registrationSequence: 7 })),
    ).toThrowError(/stale_registration/);
    expect(() =>
      service.registerNode(buildRegistration('stale-reg', { registrationSequence: 6 })),
    ).toThrowError(/stale_registration/);
    expect(() =>
      service.registerNode(buildRegistration('stale-reg', { registrationSequence: 8 })),
    ).not.toThrow();
  });

  it('health states are explicit and honestly representable (degraded/unavailable register, then report)', () => {
    const service = makeService(['health-states']);
    const descriptor = service.registerNode(
      buildRegistration('health-states', {
        advertisements: [
          advertisement('filesystem.read', ['deterministic_api'], { health: 'degraded' }),
          advertisement('filesystem.write', ['deterministic_api'], { health: 'unavailable' }),
          advertisement('application.open', ['deterministic_api']),
        ],
      }),
    );
    const byCapability = new Map(descriptor.capabilities.map((c) => [c.capability, c]));
    expect(byCapability.get('filesystem.read')?.health).toBe('degraded');
    expect(byCapability.get('filesystem.write')?.health).toBe('unavailable');
    expect(byCapability.get('application.open')?.health).toBe('healthy');
  });

  it('an invalid health value is rejected', () => {
    const service = makeService(['bad-health']);
    expect(() =>
      service.registerNode(
        buildRegistration('bad-health', {
          advertisements: [
            advertisement('filesystem.read', ['deterministic_api'], { health: 'slow' as never }),
          ],
        }),
      ),
    ).toThrowError(/invalid_registration/);
  });

  it('discovery returns capabilities in deterministic (sorted) order with trust attributes', () => {
    const service = makeService(['discovery-order']);
    const descriptor = service.registerNode(
      buildRegistration('discovery-order', {
        advertisements: [
          advertisement('filesystem.write', ['deterministic_api']),
          advertisement('application.open', ['deterministic_api']),
          advertisement('filesystem.read', ['deterministic_api']),
        ],
      }),
    );
    expect(descriptor.capabilities.map((c) => c.capability)).toEqual([
      'application.open',
      'filesystem.read',
      'filesystem.write',
    ]);
    expect(descriptor.capabilities.every((c) => c.trust.trustLevel === FIXTURE_TRUST.trustLevel)).toBe(
      true,
    );
  });

  it('two independent services derive identical node ids for the same registration (determinism)', () => {
    const serviceA = makeService(['determinism']);
    const serviceB = makeService(['determinism']);
    const a = registerFixtureNode(serviceA, 'determinism');
    const b = registerFixtureNode(serviceB, 'determinism');
    expect(a.nodeId).toBe(b.nodeId);
  });
});

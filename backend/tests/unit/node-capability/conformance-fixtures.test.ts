/**
 * V2-004 — Cross-host conformance fixtures.
 *
 * The work order requires "protocol conformance fixtures shared across host
 * classes" and the dogfooding protocol requires that two host classes
 * honestly report different eligibility for the same workflow. These tests
 * prove:
 *   - every fixture host advertises ONLY registry-canonical capability names,
 *     canonical execution classes and canonical assurance identifiers;
 *   - the fixture workflow uses ONLY canonical protocol identifiers (no
 *     platform SDK semantics leak into workflow/domain semantics);
 *   - the documented honest eligibility matrix holds: each host class reports
 *     exactly its own capability truth — a web host never claims
 *     filesystem.read even though it has browser.download (no emulation);
 *   - nodes with identical advertisements but different platform classes
 *     produce IDENTICAL decisions (platform differences enter the protocol
 *     only through advertised capabilities — constitution §4);
 *   - two host classes honestly report different eligibility for the same
 *     workflow.
 */
import { describe, it, expect } from 'vitest';
import {
  CANONICAL_WORKFLOW_FIXTURE,
  EXPECTED_HOST_ELIGIBILITY_MATRIX,
  HOST_CLASS_CONFORMANCE_FIXTURES,
  isCanonicalCapabilityName,
  isCanonicalExecutionClass,
  isCanonicalPlacementConstraint,
  type HostPlatformClass,
  type NodeCapabilityService,
} from '../../../src/node-capability/index.js';
import {
  advertisement,
  authorization,
  buildRegistration,
  DEVICE_LOCAL_POSTURE,
  makeService,
} from './helpers.js';

const HOST_CLASSES: readonly HostPlatformClass[] = [
  'web',
  'desktop',
  'ios',
  'android',
  'cloud',
];

describe('V2-004 — fixture protocol purity', () => {
  it('every fixture host advertises only registry-canonical capability names and classes', () => {
    expect(HOST_CLASS_CONFORMANCE_FIXTURES.map((f) => f.hostClass).sort()).toEqual(
      [...HOST_CLASSES].sort(),
    );
    for (const fixture of HOST_CLASS_CONFORMANCE_FIXTURES) {
      expect(fixture.advertisements.length).toBeGreaterThan(0);
      for (const adv of fixture.advertisements) {
        expect(isCanonicalCapabilityName(adv.capability)).toBe(true);
        for (const executionClass of adv.executionClasses) {
          expect(isCanonicalExecutionClass(executionClass)).toBe(true);
        }
      }
    }
  });

  it('the fixture workflow uses only canonical identifiers (no platform-specific semantics)', () => {
    expect(CANONICAL_WORKFLOW_FIXTURE.steps.length).toBe(5);
    for (const workflowStep of CANONICAL_WORKFLOW_FIXTURE.steps) {
      expect(isCanonicalCapabilityName(workflowStep.capability)).toBe(true);
      expect(isCanonicalExecutionClass(workflowStep.executionClass)).toBe(true);
      expect(isCanonicalPlacementConstraint(workflowStep.placement)).toBe(true);
    }
  });

  it('each fixture host class advertises a distinct, honest capability set', () => {
    const sets = new Map<string, string>();
    for (const fixture of HOST_CLASS_CONFORMANCE_FIXTURES) {
      for (const adv of fixture.advertisements) {
        sets.set(`${fixture.hostClass}:${adv.capability}`, fixture.hostClass);
      }
    }
    // The desktop host genuinely has filesystem.read; the web host does not.
    expect(sets.has('desktop:filesystem.read')).toBe(true);
    expect(sets.has('web:filesystem.read')).toBe(false);
    // The web host genuinely has browser.navigate; iOS fixture does not advertise it.
    expect(sets.has('web:browser.navigate')).toBe(true);
    expect(sets.has('ios:browser.navigate')).toBe(false);
    // The iOS/Android hosts genuinely have phone.call.answer; the cloud host does not.
    expect(sets.has('ios:phone.call.answer')).toBe(true);
    expect(sets.has('android:phone.call.answer')).toBe(true);
    expect(sets.has('cloud:phone.call.answer')).toBe(false);
    // The cloud host genuinely has social.post.publish; device hosts do not.
    expect(sets.has('cloud:social.post.publish')).toBe(true);
    expect(sets.has('desktop:social.post.publish')).toBe(false);
  });
});

describe('V2-004 — honest cross-host eligibility matrix', () => {
  it('each host class reports exactly the documented eligibility for every fixture step', () => {
    for (const fixture of HOST_CLASS_CONFORMANCE_FIXTURES) {
      const service = makeService([fixture.nodeKeySeed]);
      const descriptor = service.registerNode(
        buildRegistration(fixture.nodeKeySeed, {
          platformClass: fixture.hostClass,
          ownerPrincipal: fixture.ownerPrincipal,
          advertisements: fixture.advertisements,
          privacyPosture: fixture.privacyPosture,
        }),
      );
      const evaluation = service.evaluateNode(
        descriptor.nodeId,
        CANONICAL_WORKFLOW_FIXTURE,
        authorization('authorized', CANONICAL_WORKFLOW_FIXTURE.workflowVersionRef),
      );
      const expected = EXPECTED_HOST_ELIGIBILITY_MATRIX[fixture.hostClass];
      for (const workflowStep of CANONICAL_WORKFLOW_FIXTURE.steps) {
        expect(
          evaluation.steps.find((s) => s.stepId === workflowStep.stepId)?.eligible,
          `${fixture.hostClass} step ${workflowStep.stepId}`,
        ).toBe(expected[workflowStep.stepId]);
      }
      // A multi-surface workflow is not fully executable on a single host
      // class — that is the honest answer, not a failure to hide.
      expect(evaluation.workflowEligible).toBe(false);
    }
  });

  it('a web host never claims filesystem.read (it has browser.download but may not emulate)', () => {
    const service = makeService(['web-fixture']);
    const webFixture = HOST_CLASS_CONFORMANCE_FIXTURES.find((f) => f.hostClass === 'web')!;
    const descriptor = service.registerNode(
      buildRegistration('web-fixture', {
        platformClass: 'web',
        advertisements: webFixture.advertisements,
        privacyPosture: webFixture.privacyPosture,
      }),
    );
    const evaluation = service.evaluateNode(
      descriptor.nodeId,
      CANONICAL_WORKFLOW_FIXTURE,
      authorization('authorized', CANONICAL_WORKFLOW_FIXTURE.workflowVersionRef),
    );
    const readStep = evaluation.steps.find((s) => s.stepId === 'read-local-config')!;
    expect(readStep.reasons).toContain('capability_missing');
    expect(readStep.advertised).toBeNull();
  });

  it('the cloud host accumulates every violated dimension for the device-local phone step', () => {
    const service = makeService(['cloud-fixture']);
    const cloudFixture = HOST_CLASS_CONFORMANCE_FIXTURES.find((f) => f.hostClass === 'cloud')!;
    const descriptor = service.registerNode(
      buildRegistration('cloud-fixture', {
        platformClass: 'cloud',
        advertisements: cloudFixture.advertisements,
        privacyPosture: cloudFixture.privacyPosture,
      }),
    );
    const evaluation = service.evaluateNode(
      descriptor.nodeId,
      CANONICAL_WORKFLOW_FIXTURE,
      authorization('authorized', CANONICAL_WORKFLOW_FIXTURE.workflowVersionRef),
    );
    const phoneStep = evaluation.steps.find((s) => s.stepId === 'answer-screening-call')!;
    expect(phoneStep.reasons).toEqual([
      'capability_missing',
      'placement_forbidden',
      'privacy_data_locality',
    ]);
    const humanStep = evaluation.steps.find((s) => s.stepId === 'notify-human-approval')!;
    expect(humanStep.reasons).toEqual([
      'capability_missing',
      'privacy_human_approval_unsupported',
    ]);
  });

  it('the same semantic step yields equivalent decisions on hosts with equal advertisements', () => {
    // notifications.observe + human approval is supported by web, desktop,
    // ios and android fixtures — the decision for that step must be identical.
    const decisions = HOST_CLASS_CONFORMANCE_FIXTURES.filter(
      (f) => f.hostClass !== 'cloud',
    ).map((fixture) => {
      const service = makeService([fixture.nodeKeySeed]);
      const descriptor = service.registerNode(
        buildRegistration(fixture.nodeKeySeed, {
          platformClass: fixture.hostClass,
          advertisements: fixture.advertisements,
          privacyPosture: fixture.privacyPosture,
        }),
      );
      const evaluation = service.evaluateNode(
        descriptor.nodeId,
        CANONICAL_WORKFLOW_FIXTURE,
        authorization('authorized', CANONICAL_WORKFLOW_FIXTURE.workflowVersionRef),
      );
      return evaluation.steps.find((s) => s.stepId === 'notify-human-approval')!;
    });
    for (const decision of decisions) {
      expect(decision.eligible).toBe(true);
      expect(decision.reasons).toEqual([]);
      expect(decision.resolvedExecutionClass).toBe('human');
    }
  });
});

describe('V2-004 — platform semantics equivalence (constitution §4)', () => {
  function buildServiceWithPlatform(platformClass: HostPlatformClass): NodeCapabilityService {
    return makeService([`equivalence-${platformClass}`]);
  }

  it('identical advertisements on different platform classes produce identical decisions', () => {
    const advertisements = [
      advertisement('filesystem.read', ['deterministic_api']),
      advertisement('browser.navigate', ['deterministic_api']),
    ];
    const evaluations = (['web', 'desktop', 'ios'] as const).map((platformClass) => {
      const service = buildServiceWithPlatform(platformClass);
      const descriptor = service.registerNode(
        buildRegistration(`equivalence-${platformClass}`, {
          platformClass,
          advertisements,
          privacyPosture: DEVICE_LOCAL_POSTURE,
        }),
      );
      return service.evaluateNode(
        descriptor.nodeId,
        CANONICAL_WORKFLOW_FIXTURE,
        authorization('authorized', CANONICAL_WORKFLOW_FIXTURE.workflowVersionRef),
      );
    });
    const signatures = evaluations.map((evaluation) =>
      JSON.stringify(
        evaluation.steps.map((s) => ({
          stepId: s.stepId,
          eligible: s.eligible,
          reasons: s.reasons,
          resolvedExecutionClass: s.resolvedExecutionClass,
          viaDeclaredFallback: s.viaDeclaredFallback,
          placementTier: s.placementTier,
        })),
      ),
    );
    expect(new Set(signatures).size).toBe(1);
  });

  it('two host classes honestly report different eligibility for the same workflow', () => {
    function evaluateOnHostClass(hostClass: 'web' | 'desktop'): boolean[] {
      const fixture = HOST_CLASS_CONFORMANCE_FIXTURES.find((f) => f.hostClass === hostClass)!;
      const service = makeService([`difference-${hostClass}`]);
      const descriptor = service.registerNode(
        buildRegistration(`difference-${hostClass}`, {
          platformClass: fixture.hostClass,
          advertisements: fixture.advertisements,
          privacyPosture: fixture.privacyPosture,
        }),
      );
      const evaluation = service.evaluateNode(
        descriptor.nodeId,
        CANONICAL_WORKFLOW_FIXTURE,
        authorization('authorized', CANONICAL_WORKFLOW_FIXTURE.workflowVersionRef),
      );
      return evaluation.steps.map((s) => s.eligible);
    }
    const web = evaluateOnHostClass('web');
    const desktop = evaluateOnHostClass('desktop');
    expect(web).not.toEqual(desktop);
    // Exactly the device-filesystem step differs (both lack phone/social).
    expect(web).toEqual([true, false, false, false, true]);
    expect(desktop).toEqual([true, true, false, false, true]);
  });
});

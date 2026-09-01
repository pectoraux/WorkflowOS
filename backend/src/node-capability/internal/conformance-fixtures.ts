/**
 * V2-004 — Cross-host protocol conformance fixtures.
 *
 * The work order requires "protocol conformance fixtures shared across host
 * classes": one canonical workflow expressed purely in registry identifiers,
 * five honest host-class fixtures (web, desktop, ios, android, cloud), and
 * the documented eligibility matrix the protocol MUST reproduce exactly.
 *
 * Honesty rules (constitution §4/§13): platform differences enter the
 * protocol ONLY through advertised capabilities — a web host never claims
 * `filesystem.read` even though it has `browser.download`; an iOS host never
 * claims `browser.navigate`; a cloud host never claims `phone.call.answer`.
 * Two host classes honestly report different eligibility for the same
 * workflow; identical advertisements on different platform classes produce
 * identical decisions.
 */
import type {
  CapabilityAdvertisement,
  ExecutionClass,
  HostPlatformClass,
  NodePrivacyPosture,
  StepCapabilityRequirement,
  WorkflowExecutionRequest,
} from '../types.js';

interface HostClassConformanceFixture {
  hostClass: HostPlatformClass;
  /** Deterministic key-material seed for the fixture node's registration. */
  nodeKeySeed: string;
  ownerPrincipal: string;
  advertisements: CapabilityAdvertisement[];
  privacyPosture: NodePrivacyPosture;
}

const VERIFIED_SOFTWARE_SIGNED = {
  trustLevel: 'verified' as const,
  assurance: 'software_signed' as const,
};

function advertisementOf(
  capability: string,
  executionClasses: readonly ExecutionClass[],
): CapabilityAdvertisement {
  return {
    capability,
    capabilityVersion: 1,
    executionClasses: [...executionClasses],
    health: 'healthy',
    trust: { ...VERIFIED_SOFTWARE_SIGNED },
  };
}

const DEVICE_STRICT_POSTURE: NodePrivacyPosture = {
  supportsHumanApproval: true,
  cloudEgress: 'none',
  secretDelivery: 'opaque_reference_only',
};

const WEB_EGRESSING_POSTURE: NodePrivacyPosture = {
  supportsHumanApproval: true,
  cloudEgress: 'allowed',
  secretDelivery: 'opaque_reference_only',
};

const CLOUD_POSTURE: NodePrivacyPosture = {
  supportsHumanApproval: false,
  cloudEgress: 'allowed',
  secretDelivery: 'opaque_reference_only',
};

/**
 * One honest capability set per host class. These sets are deliberately
 * DIFFERENT — the cross-surface conformance matrix depends on the
 * differences, not on uniform hosts.
 */
export const HOST_CLASS_CONFORMANCE_FIXTURES: readonly HostClassConformanceFixture[] = [
  {
    hostClass: 'web',
    nodeKeySeed: 'fixture-host-web',
    ownerPrincipal: 'user:fixture-web-operator',
    advertisements: [
      advertisementOf('browser.navigate', ['deterministic_api']),
      advertisementOf('browser.observe', ['deterministic_api']),
      advertisementOf('browser.click', ['deterministic_api']),
      advertisementOf('browser.download', ['deterministic_api']),
      advertisementOf('notifications.observe', ['deterministic_api', 'human']),
    ],
    // A browser host genuinely surfaces confirmations AND egresses to web
    // services — both are honestly declared.
    privacyPosture: WEB_EGRESSING_POSTURE,
  },
  {
    hostClass: 'desktop',
    nodeKeySeed: 'fixture-host-desktop',
    ownerPrincipal: 'user:fixture-desktop-operator',
    advertisements: [
      advertisementOf('filesystem.read', ['deterministic_api']),
      advertisementOf('filesystem.write', ['deterministic_api']),
      advertisementOf('application.open', ['deterministic_api', 'agentic_computer_use']),
      advertisementOf('screen.observe', ['deterministic_api']),
      advertisementOf('browser.navigate', ['deterministic_api']),
      advertisementOf('notifications.observe', ['deterministic_api', 'human']),
    ],
    privacyPosture: DEVICE_STRICT_POSTURE,
  },
  {
    hostClass: 'ios',
    nodeKeySeed: 'fixture-host-ios',
    ownerPrincipal: 'user:fixture-ios-operator',
    advertisements: [
      advertisementOf('phone.call.observe', ['deterministic_api']),
      advertisementOf('phone.call.identify', ['deterministic_api']),
      advertisementOf('phone.call.answer', ['deterministic_api']),
      advertisementOf('phone.call.reject', ['deterministic_api']),
      advertisementOf('phone.call.end', ['deterministic_api']),
      advertisementOf('contacts.read', ['deterministic_api']),
      advertisementOf('notifications.observe', ['deterministic_api', 'human']),
    ],
    privacyPosture: DEVICE_STRICT_POSTURE,
  },
  {
    hostClass: 'android',
    nodeKeySeed: 'fixture-host-android',
    ownerPrincipal: 'user:fixture-android-operator',
    advertisements: [
      advertisementOf('phone.call.observe', ['deterministic_api']),
      advertisementOf('phone.call.identify', ['deterministic_api']),
      advertisementOf('phone.call.answer', ['deterministic_api']),
      advertisementOf('phone.call.reject', ['deterministic_api']),
      advertisementOf('phone.call.end', ['deterministic_api']),
      advertisementOf('contacts.read', ['deterministic_api']),
      advertisementOf('contacts.search', ['deterministic_api']),
      advertisementOf('messaging.observe', ['deterministic_api']),
      advertisementOf('notifications.observe', ['deterministic_api', 'human']),
    ],
    privacyPosture: DEVICE_STRICT_POSTURE,
  },
  {
    hostClass: 'cloud',
    nodeKeySeed: 'fixture-host-cloud',
    ownerPrincipal: 'org:fixture-cloud-operator',
    advertisements: [
      advertisementOf('social.post.observe', ['deterministic_api']),
      advertisementOf('social.post.publish', ['deterministic_api']),
      advertisementOf('social.engagement.observe', ['deterministic_api']),
      advertisementOf('workflow.execute', ['deterministic_api']),
      advertisementOf('workflow.deploy', ['deterministic_api']),
      advertisementOf('workflow.observe', ['deterministic_api']),
    ],
    // A cloud host honestly declares egress and cannot surface a
    // human-approval interaction on a user's device.
    privacyPosture: CLOUD_POSTURE,
  },
];

function stepRequirement(
  stepId: string,
  capability: string,
  executionClass: StepCapabilityRequirement['executionClass'],
  placement: StepCapabilityRequirement['placement'],
  privacy: StepCapabilityRequirement['privacy'],
): StepCapabilityRequirement {
  return { stepId, capability, executionClass, placement, privacy };
}

/**
 * The canonical cross-host conformance workflow: five steps whose
 * requirements together span browser, filesystem, phone, social and
 * human-approval semantics — every identifier registry-canonical, no
 * platform SDK semantics anywhere.
 */
export const CANONICAL_WORKFLOW_FIXTURE: WorkflowExecutionRequest = {
  workflowVersionRef: 'workflow-version:fixture:conformance@1',
  steps: [
    stepRequirement('navigate-start-page', 'browser.navigate', 'deterministic_api', 'any_supported_node', {
      dataLocality: 'device_or_cloud',
      requiresHumanApproval: false,
    }),
    stepRequirement('read-local-config', 'filesystem.read', 'deterministic_api', 'device_preferred', {
      dataLocality: 'device_or_cloud',
      requiresHumanApproval: false,
    }),
    stepRequirement('answer-screening-call', 'phone.call.answer', 'deterministic_api', 'device_local', {
      dataLocality: 'device_only',
      requiresHumanApproval: false,
    }),
    stepRequirement('publish-engagement-summary', 'social.post.publish', 'deterministic_api', 'cloud_preferred', {
      dataLocality: 'device_or_cloud',
      requiresHumanApproval: false,
    }),
    stepRequirement('notify-human-approval', 'notifications.observe', 'human', 'any_supported_node', {
      dataLocality: 'device_or_cloud',
      requiresHumanApproval: true,
    }),
  ],
};

/**
 * The documented honest eligibility matrix: what each host class MUST report
 * for every fixture step. A multi-surface workflow is NOT fully executable
 * on a single host class — that is the honest answer, not a failure to hide.
 */
export const EXPECTED_HOST_ELIGIBILITY_MATRIX: Readonly<
  Record<HostPlatformClass, Readonly<Record<string, boolean>>>
> = {
  web: {
    'navigate-start-page': true,
    'read-local-config': false,
    'answer-screening-call': false,
    'publish-engagement-summary': false,
    'notify-human-approval': true,
  },
  desktop: {
    'navigate-start-page': true,
    'read-local-config': true,
    'answer-screening-call': false,
    'publish-engagement-summary': false,
    'notify-human-approval': true,
  },
  ios: {
    'navigate-start-page': false,
    'read-local-config': false,
    'answer-screening-call': true,
    'publish-engagement-summary': false,
    'notify-human-approval': true,
  },
  android: {
    'navigate-start-page': false,
    'read-local-config': false,
    'answer-screening-call': true,
    'publish-engagement-summary': false,
    'notify-human-approval': true,
  },
  cloud: {
    'navigate-start-page': false,
    'read-local-config': false,
    'answer-screening-call': false,
    'publish-engagement-summary': true,
    'notify-human-approval': false,
  },
};

/**
 * V2-004 — Embedded consumption of the frozen V2 protocol registry
 * (V2-CTRL-003).
 *
 * The registry is the ONLY source of protocol-visible identifiers. The
 * embedded values below are proven byte-equal to the repository-resident
 * `spec/architecture/v2/V2-CTRL-003-protocol-registry.json` on every governed
 * field by `backend/tests/unit/node-capability/canonical-registry.test.ts` —
 * drift or silent renames fail the battery. `aliasesForbidden` and
 * `authorityRules` are binding.
 */
import type { AssuranceLevel, ExecutionClass, PlacementConstraint } from '../types.js';

/** Protocol version of this Node + Capability protocol implementation. */
export const CURRENT_PROTOCOL_VERSION = '2.0';

/** Repository-relative path of the frozen registry this module consumes. */
export const PROTOCOL_REGISTRY_SOURCE = 'spec/architecture/v2/V2-CTRL-003-protocol-registry.json';

/** Canonical capability namespace (V2-CTRL-003 `capabilities`, flattened). */
export const CANONICAL_CAPABILITY_NAMES: ReadonlySet<string> = new Set<string>([
  // browser
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.observe',
  'browser.download',
  'browser.upload',
  // desktop / filesystem / applications
  'filesystem.read',
  'filesystem.write',
  'application.open',
  'application.observe',
  'application.interact',
  'screen.observe',
  'ui.inspect',
  'ui.click',
  'ui.type',
  // phone / calling
  'phone.call.observe',
  'phone.call.identify',
  'phone.call.answer',
  'phone.call.reject',
  'phone.call.end',
  // messaging / contacts
  'messaging.observe',
  'messaging.read',
  'messaging.send',
  'contacts.read',
  'contacts.search',
  'contacts.create',
  // device sensors / media
  'notifications.observe',
  'microphone.capture',
  'speech.synthesis',
  'camera.capture',
  'location.read',
  // spreadsheets / business applications
  'spreadsheet.read',
  'spreadsheet.edit',
  // social systems
  'social.post.observe',
  'social.post.publish',
  'social.engagement.observe',
  // WorkflowOS-native
  'workflow.execute',
  'workflow.pause',
  'workflow.resume',
  'workflow.cancel',
  'workflow.deploy',
  'workflow.observe',
  // integration / development examples
  'github.repository.read',
  'github.pull_request.create',
  'github.pull_request.merge',
]);

/** Canonical event namespace (V2-CTRL-003 `events`). */
export const CANONICAL_EVENT_NAMES: ReadonlySet<string> = new Set<string>([
  'workflow.run.requested',
  'workflow.run.started',
  'workflow.step.started',
  'workflow.step.completed',
  'workflow.run.paused',
  'workflow.run.resumed',
  'workflow.run.completed',
  'workflow.run.failed',
  'capability.invocation.requested',
  'capability.invocation.completed',
  'observation.recorded',
  'verification.completed',
  'execution.attestation.issued',
  'execution.attestation.verified',
  'execution.proof.updated',
  'device.connected',
  'device.disconnected',
  'phone.call.received',
  'phone.call.ended',
  'messaging.message.received',
  'notification.received',
  'file.created',
  'file.changed',
  'application.opened',
  'social.post.engagement.threshold_crossed',
  'workflow.deployment.enabled',
  'workflow.deployment.disabled',
]);

/** Canonical execution-class identifiers, in registry order. */
export const CANONICAL_EXECUTION_CLASSES: readonly ExecutionClass[] = [
  'deterministic_api',
  'agentic_computer_use',
  'human',
  'subworkflow',
];

/** Canonical placement/locality identifiers, in registry order. */
export const CANONICAL_PLACEMENT_CONSTRAINTS: readonly PlacementConstraint[] = [
  'device_local',
  'device_preferred',
  'cloud_allowed',
  'cloud_preferred',
  'cloud_required',
  'any_supported_node',
];

/** Canonical execution assurance identifiers, in registry order. */
export const CANONICAL_ASSURANCE_LEVELS: readonly AssuranceLevel[] = [
  'software_signed',
  'hardware_backed',
  'tee_attested',
  'verifiable_computation',
];

/** Assurance strength order — identical to the registry order. */
export const ASSURANCE_STRENGTH_ORDER: readonly AssuranceLevel[] = CANONICAL_ASSURANCE_LEVELS;

/** Registry authority rules (binding for this protocol surface). */
export const REGISTRY_AUTHORITY_RULES: readonly string[] = [
  'capability-advertisement-is-not-authorization',
  'marketplace-entitlement-is-not-execution-authority',
  'command-ack-is-not-side-effect-evidence',
  'signature-is-not-automatic-execution-truth',
  'attestation-is-not-verification-authority',
];

export function isCanonicalCapabilityName(name: string): boolean {
  return CANONICAL_CAPABILITY_NAMES.has(name);
}

export function isCanonicalEventName(name: string): boolean {
  return CANONICAL_EVENT_NAMES.has(name);
}

export function isCanonicalExecutionClass(executionClass: string): boolean {
  return CANONICAL_EXECUTION_CLASSES.includes(executionClass as ExecutionClass);
}

export function isCanonicalPlacementConstraint(placement: string): boolean {
  return CANONICAL_PLACEMENT_CONSTRAINTS.includes(placement as PlacementConstraint);
}

export function isCanonicalAssuranceLevel(level: string): boolean {
  return CANONICAL_ASSURANCE_LEVELS.includes(level as AssuranceLevel);
}

/** Assurance ordinal used for floor comparisons (higher = stronger). */
export function assuranceStrength(level: AssuranceLevel): number {
  const index = CANONICAL_ASSURANCE_LEVELS.indexOf(level);
  if (index < 0) {
    throw new Error(`assuranceStrength: non-canonical assurance level ${level}`);
  }
  return index;
}

export interface ProtocolVersionNegotiation {
  compatible: boolean;
  /** The version the session proceeds with when compatible, else null. */
  negotiatedVersion: string | null;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)$/;

/**
 * Protocol version negotiation: the same major version is compatible
 * (minors are forward/backward compatible); foreign majors and malformed
 * versions are incompatible (fail closed).
 */
export function negotiateProtocolVersion(
  offered: string,
  current: string,
): ProtocolVersionNegotiation {
  const offeredMatch = VERSION_PATTERN.exec(offered);
  const currentMatch = VERSION_PATTERN.exec(current);
  if (!offeredMatch || !currentMatch) {
    return { compatible: false, negotiatedVersion: null };
  }
  const offeredMajor = Number.parseInt(offeredMatch[1]!, 10);
  const currentMajor = Number.parseInt(currentMatch[1]!, 10);
  if (offeredMajor !== currentMajor) {
    return { compatible: false, negotiatedVersion: null };
  }
  return { compatible: true, negotiatedVersion: current };
}

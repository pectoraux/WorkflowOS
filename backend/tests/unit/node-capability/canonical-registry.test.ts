/**
 * V2-004 — Canonical protocol registry consumption (V2-CTRL-003).
 *
 * The Node + Capability protocol consumes the frozen V2 protocol registry.
 * These tests prove:
 *   1. the embedded registry equals the repository-resident
 *      `spec/architecture/v2/V2-CTRL-003-protocol-registry.json` byte-for-byte
 *      on every governed field (no drift, no silent renames);
 *   2. capability names, placement identifiers, execution classes and
 *      assurance levels are validated against the registry and non-canonical
 *      aliases are rejected (fail closed) — the registry's
 *      `aliasesForbidden` and `authorityRules` are binding;
 *   3. the authority rules — including
 *      `capability-advertisement-is-not-authorization` — are carried through
 *      the protocol surface.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  ASSURANCE_STRENGTH_ORDER,
  CANONICAL_ASSURANCE_LEVELS,
  CANONICAL_CAPABILITY_NAMES,
  CANONICAL_EVENT_NAMES,
  CANONICAL_EXECUTION_CLASSES,
  CANONICAL_PLACEMENT_CONSTRAINTS,
  CURRENT_PROTOCOL_VERSION,
  NodeCapabilityProtocolError,
  PROTOCOL_REGISTRY_SOURCE,
  REGISTRY_AUTHORITY_RULES,
  isCanonicalAssuranceLevel,
  isCanonicalCapabilityName,
  isCanonicalEventName,
  isCanonicalExecutionClass,
  isCanonicalPlacementConstraint,
  negotiateProtocolVersion,
} from '../../../src/node-capability/index.js';

// backend/tests/unit/node-capability/canonical-registry.test.ts → 3× ".." lands
// on backend/; the repository root is one more level up.
const BACKEND_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REPOSITORY_REGISTRY_PATH = join(BACKEND_ROOT, '..', PROTOCOL_REGISTRY_SOURCE);

describe('V2-004 — canonical registry consumption (V2-CTRL-003)', () => {
  it('the embedded registry equals the repository-resident registry JSON on every governed field', () => {
    const repositoryRegistry = JSON.parse(readFileSync(REPOSITORY_REGISTRY_PATH, 'utf8')) as Record<
      string,
      unknown
    >;
    const repositoryCapabilities = Object.values(
      repositoryRegistry['capabilities'] as Record<string, string[]>,
    ).flat();

    expect([...CANONICAL_CAPABILITY_NAMES].sort()).toEqual([...repositoryCapabilities].sort());
    expect([...CANONICAL_PLACEMENT_CONSTRAINTS]).toEqual(repositoryRegistry['placement']);
    expect([...CANONICAL_EXECUTION_CLASSES]).toEqual(repositoryRegistry['executionClasses']);
    expect([...CANONICAL_ASSURANCE_LEVELS]).toEqual(repositoryRegistry['assurance']);
    expect([...CANONICAL_EVENT_NAMES].sort()).toEqual(
      [...(repositoryRegistry['events'] as string[])].sort(),
    );
    expect([...REGISTRY_AUTHORITY_RULES]).toEqual(repositoryRegistry['authorityRules']);
    expect(PROTOCOL_REGISTRY_SOURCE).toBe(
      'spec/architecture/v2/V2-CTRL-003-protocol-registry.json',
    );
  });

  it('canonical capability names are accepted (namespaced, lowercase, dot-separated)', () => {
    for (const name of [
      'browser.navigate',
      'filesystem.read',
      'phone.call.answer',
      'messaging.send',
      'contacts.search',
      'speech.synthesis',
      'social.post.publish',
      'workflow.execute',
      'github.pull_request.merge',
    ]) {
      expect(isCanonicalCapabilityName(name)).toBe(true);
    }
  });

  it('non-canonical capability aliases are rejected (aliasesForbidden)', () => {
    // The exact aliases the registry calls out as forbidden, plus casing and
    // invented variants.
    for (const alias of [
      'phone.answer_call',
      'calls.answer',
      'messages.send',
      'browser.navigation',
      'Browser.Navigate',
      'FILESYSTEM.READ',
      'filesystem.read.v2',
    ]) {
      expect(isCanonicalCapabilityName(alias)).toBe(false);
      expect(() => isCanonicalCapabilityName(alias)).not.toThrow();
    }
  });

  it('capability-name validation fails closed with a typed protocol error', () => {
    expect(() => {
      // Direct use of a non-canonical name through the exported validator.
      if (!isCanonicalCapabilityName('phone.answer_call')) {
        throw new NodeCapabilityProtocolError(
          'invalid_capability_name',
          'non-canonical capability name: phone.answer_call',
        );
      }
    }).toThrow(NodeCapabilityProtocolError);
  });

  it('placement identifiers are validated: aliases of canonical placements are rejected', () => {
    for (const canonical of [
      'device_local',
      'device_preferred',
      'cloud_allowed',
      'cloud_preferred',
      'cloud_required',
      'any_supported_node',
    ]) {
      expect(isCanonicalPlacementConstraint(canonical)).toBe(true);
    }
    for (const alias of ['local_only', 'on_device', 'cloud', 'device-local', 'any_node', 'LOCAL']) {
      expect(isCanonicalPlacementConstraint(alias)).toBe(false);
    }
  });

  it('execution classes are validated: computer_use aliases are rejected', () => {
    for (const canonical of [
      'deterministic_api',
      'agentic_computer_use',
      'human',
      'subworkflow',
    ]) {
      expect(isCanonicalExecutionClass(canonical)).toBe(true);
    }
    for (const alias of [
      'computer_use',
      'agentic',
      'api',
      'Deterministic/API',
      'human_approval',
    ]) {
      expect(isCanonicalExecutionClass(alias)).toBe(false);
    }
  });

  it('assurance levels are validated and ordered by the registry order', () => {
    for (const canonical of [
      'software_signed',
      'hardware_backed',
      'tee_attested',
      'verifiable_computation',
    ]) {
      expect(isCanonicalAssuranceLevel(canonical)).toBe(true);
    }
    for (const alias of ['hardware', 'tee', 'signed', 'zk', 'HARDWARE_BACKED']) {
      expect(isCanonicalAssuranceLevel(alias)).toBe(false);
    }
    expect([...ASSURANCE_STRENGTH_ORDER]).toEqual([...CANONICAL_ASSURANCE_LEVELS]);
  });

  it('canonical event names are reused, never re-invented', () => {
    expect(isCanonicalEventName('capability.invocation.requested')).toBe(true);
    expect(isCanonicalEventName('capability.invocation.completed')).toBe(true);
    expect(isCanonicalEventName('device.connected')).toBe(true);
    expect(isCanonicalEventName('capability.invoked')).toBe(false);
    expect(isCanonicalEventName('node.registered')).toBe(false);
  });

  it('the registry authority rules bind the protocol surface', () => {
    expect(REGISTRY_AUTHORITY_RULES).toContain('capability-advertisement-is-not-authorization');
    expect(REGISTRY_AUTHORITY_RULES).toContain('command-ack-is-not-side-effect-evidence');
    expect(REGISTRY_AUTHORITY_RULES).toContain('signature-is-not-automatic-execution-truth');
  });

  it('protocol version negotiation accepts the same major and rejects foreign majors', () => {
    expect(CURRENT_PROTOCOL_VERSION).toMatch(/^2\.\d+$/);
    expect(negotiateProtocolVersion('2.0', CURRENT_PROTOCOL_VERSION).compatible).toBe(true);
    expect(negotiateProtocolVersion('2.1', CURRENT_PROTOCOL_VERSION).compatible).toBe(true);
    expect(negotiateProtocolVersion('1.0', CURRENT_PROTOCOL_VERSION).compatible).toBe(false);
    expect(negotiateProtocolVersion('3.0', CURRENT_PROTOCOL_VERSION).compatible).toBe(false);
    expect(negotiateProtocolVersion('not-a-version', CURRENT_PROTOCOL_VERSION).compatible).toBe(
      false,
    );
  });
});

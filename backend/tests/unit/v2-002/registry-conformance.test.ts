import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKFLOW_VISIBILITIES,
  DIGEST_ALGORITHM,
  V2_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  WorkflowRepositoryError,
} from '@root/v2/workflow-repository/index.js';

/**
 * V2-002 — canonical protocol-registry conformance.
 *
 * Every protocol-visible identifier used by the V2-002 repository surface
 * comes from V2-CTRL-003 (`spec/architecture/v2/V2-CTRL-003-protocol-registry.json`).
 * No aliases may be introduced (registry rule: aliasesForbidden = true).
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const registry = JSON.parse(
  readFileSync(
    join(REPO_ROOT, 'spec', 'architecture', 'v2', 'V2-CTRL-003-protocol-registry.json'),
    'utf-8',
  ),
) as {
  visibility: string[];
  digest: { algorithm: string; input: string; presentationExcluded: boolean };
  aliasesForbidden: boolean;
};

describe('V2-002 — V2-CTRL-003 protocol registry conformance', () => {
  it('uses exactly the canonical registry visibility identifiers (no aliases)', () => {
    expect([...WORKFLOW_VISIBILITIES]).toEqual(registry.visibility);
    expect(registry.visibility).toEqual(['private', 'organization', 'public']);
    // Registry forbids aliases; the repository vocabulary has no duplicates
    // (an alias of a canonical identifier would be a drift signal).
    expect(new Set(WORKFLOW_VISIBILITIES).size).toBe(WORKFLOW_VISIBILITIES.length);
  });

  it('uses the canonical digest rule from the registry', () => {
    expect(DIGEST_ALGORITHM).toBe(registry.digest.algorithm);
    expect(registry.digest.algorithm).toBe('SHA-256');
    expect(registry.digest.input).toBe('canonical-json(semantic-object)');
    expect(registry.digest.presentationExcluded).toBe(true);
    expect(registry.aliasesForbidden).toBe(true);
  });

  it('declares the WorkflowOS 2.0 protocol version and a closed supported set', () => {
    expect(V2_PROTOCOL_VERSION).toBe('2.0');
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(V2_PROTOCOL_VERSION);
    // Fail closed: unknown protocol versions are a typed error, not a silent
    // default (exercised end-to-end in the immutable-versions suite).
    expect(new WorkflowRepositoryError('unsupported-protocol', 'x').code).toBe(
      'unsupported-protocol',
    );
  });
});

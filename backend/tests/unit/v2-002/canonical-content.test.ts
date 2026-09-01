import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalizeJson,
  computeContentDigest,
  deriveWorkflowVersionId,
  DIGEST_ALGORITHM,
} from '@root/v2/workflow-repository/index.js';

/**
 * V2-002 — canonical content addressing (deterministic, registry-governed).
 *
 * The WorkflowVersion content digest follows the V2-CTRL-003 canonical rule:
 * SHA-256 over canonical-json(semantic-object) — deterministic object-key
 * ordering, no insignificant whitespace. Repository metadata (name,
 * description, visibility, marketplace pricing, UX state, placement) is NOT
 * part of the version content digest.
 */

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('V2-002 — canonical content addressing', () => {
  it('canonicalizes JSON with sorted object keys and no insignificant whitespace', () => {
    expect(canonicalizeJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalizeJson({ z: { y: [3, 1, 2], x: null }, a: true })).toBe(
      '{"a":true,"z":{"x":null,"y":[3,1,2]}}',
    );
    // Array ordering is preserved (arrays are ordered; only object keys sort).
    expect(canonicalizeJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('key-order permutations converge to identical canonical bytes (determinism)', () => {
    const left = {
      name: 'pr-triage',
      steps: [{ id: 's1', capability: 'github.repository.read' }],
      title: 'Daily GitHub PR triage',
    };
    const right = {
      title: 'Daily GitHub PR triage',
      steps: [{ capability: 'github.repository.read', id: 's1' }],
      name: 'pr-triage',
    };
    expect(canonicalizeJson(left)).toBe(canonicalizeJson(right));
  });

  it('computes the content digest as SHA-256 hex over the canonical form (registry rule)', () => {
    const content = { b: 2, a: 1 };
    expect(computeContentDigest(content)).toBe(sha256hex('{"a":1,"b":2}'));
    expect(computeContentDigest(content)).toMatch(/^[0-9a-f]{64}$/);
    expect(DIGEST_ALGORITHM).toBe('SHA-256');
  });

  it('repository metadata is not part of the version content digest (discrimination)', () => {
    const content = { steps: [{ id: 's1' }] };
    const d1 = computeContentDigest(content);
    // The same semantic content yields the same digest …
    expect(computeContentDigest({ steps: [{ id: 's1' }] })).toBe(d1);
    // … while different semantic content yields a different digest.
    expect(computeContentDigest({ steps: [{ id: 's2' }] })).not.toBe(d1);
    // Presentation formatting (key order) never changes the digest.
    expect(
      computeContentDigest({ steps: [{ id: 's1' }] }) ===
        computeContentDigest({ steps: [{ id: 's1' }] }),
    ).toBe(true);
  });

  it('rejects non-JSON values deterministically (fail closed)', () => {
    expect(() => canonicalizeJson({ fn: (): number => 1 })).toThrow();
    expect(() => canonicalizeJson({ u: undefined })).toThrow();
    expect(() => canonicalizeJson(Infinity)).toThrow();
    expect(() => canonicalizeJson(NaN)).toThrow();
    expect(() => canonicalizeJson(BigInt(1))).toThrow();
    expect(() => canonicalizeJson(Symbol('x'))).toThrow();
  });

  it('derives the version identity deterministically from the owning identity inputs', () => {
    const input = {
      workflowId: '0f0e0d0c-0000-4000-8000-000000000001',
      contentDigest: 'a'.repeat(64),
      parentVersionId: null as string | null,
      protocolVersion: '2.0',
    };
    const id = deriveWorkflowVersionId(input);
    expect(id).toMatch(/^wfv_[0-9a-f]{64}$/);
    // Deterministic: identical inputs converge to the identical id.
    expect(deriveWorkflowVersionId(input)).toBe(id);

    // Every identity input is load-bearing (mutation discrimination):
    expect(
      deriveWorkflowVersionId({ ...input, parentVersionId: 'wfv_' + 'b'.repeat(64) }),
    ).not.toBe(id);
    expect(
      deriveWorkflowVersionId({
        ...input,
        workflowId: '0f0e0d0c-0000-4000-8000-000000000002',
      }),
    ).not.toBe(id);
    expect(deriveWorkflowVersionId({ ...input, contentDigest: 'c'.repeat(64) })).not.toBe(id);
    expect(deriveWorkflowVersionId({ ...input, protocolVersion: '3.0' })).not.toBe(id);
  });
});

import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the deterministic conversion identity proofs.
 *
 * The identity dimensions are MANDATORY: tenant + project + logical failure
 * key. The environment is DELIBERATELY absent (the same logical failure
 * across environments is ONE engineering problem — it converges on ONE
 * Work Item; the environment participates in the signal identity and the
 * assessment's blast radius, never in the conversion identity).
 */
import {
  deriveConversionIdentity,
  deriveConversionRecordId,
  deriveProposalTitle,
  deriveArchitectureImpact,
} from '../../src/feedback-conversion/index.js';

describe('WORK-068 — the deterministic conversion identity', () => {
  it('is deterministic: the same identity inputs always derive the same conversion key', () => {
    const a = deriveConversionIdentity({ tenantId: 't1', projectId: 'p1', logicalFailureKey: 'k' });
    const b = deriveConversionIdentity({ tenantId: 't1', projectId: 'p1', logicalFailureKey: 'k' });
    expect(a.conversionKey).toBe(b.conversionKey);
    expect(a.identityFingerprint).toBe(b.identityFingerprint);
  });

  it('uses the SIGWI- prefix (the deterministic proposed Work Item id — the PLAN- prefix precedent)', () => {
    const identity = deriveConversionIdentity({ tenantId: 't', projectId: 'p', logicalFailureKey: 'k' });
    expect(identity.conversionKey).toMatch(/^SIGWI-[0-9a-f]{24}$/);
    expect(identity.identityFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('TENANT participates: different tenants never collapse (tenant A/project X ≠ tenant B/project X)', () => {
    const a = deriveConversionIdentity({ tenantId: 'tenant-A', projectId: 'X', logicalFailureKey: 'k' });
    const b = deriveConversionIdentity({ tenantId: 'tenant-B', projectId: 'X', logicalFailureKey: 'k' });
    expect(a.conversionKey).not.toBe(b.conversionKey);
  });

  it('PROJECT participates: different projects never collapse (tenant A/project X ≠ tenant A/project Y)', () => {
    const a = deriveConversionIdentity({ tenantId: 'tenant-A', projectId: 'X', logicalFailureKey: 'k' });
    const b = deriveConversionIdentity({ tenantId: 'tenant-A', projectId: 'Y', logicalFailureKey: 'k' });
    expect(a.conversionKey).not.toBe(b.conversionKey);
  });

  it('LOGICAL FAILURE KEY participates: different problems never collapse', () => {
    const a = deriveConversionIdentity({ tenantId: 't', projectId: 'p', logicalFailureKey: 'problem-1' });
    const b = deriveConversionIdentity({ tenantId: 't', projectId: 'p', logicalFailureKey: 'problem-2' });
    expect(a.conversionKey).not.toBe(b.conversionKey);
  });

  it('ENVIRONMENT is deliberately ABSENT: the same logical failure across environments converges on ONE work-item identity', () => {
    // The environment is not an identity INPUT at all — the identity inputs
    // are exactly (tenant, project, logicalFailureKey). Two signals for the
    // same logical failure in different environments carry the SAME
    // conversion key (they converge; the breadth shows in the assessment).
    const identity = deriveConversionIdentity({ tenantId: 't', projectId: 'p', logicalFailureKey: 'k' });
    expect(Object.keys(identity)).toContain('conversionKey');
    // The convergence proof is structural: no environment field exists on
    // ConversionIdentityInput — verified by the type + the derived-key
    // equality regardless of any environment dimension the CALLER knows.
    const again = deriveConversionIdentity({ tenantId: 't', projectId: 'p', logicalFailureKey: 'k' });
    expect(again.conversionKey).toBe(identity.conversionKey);
  });

  it('the record identity is deterministic over (conversionKey, architectureVersionId, signalId, decision) — re-delivery of the same decision converges', () => {
    const a = deriveConversionRecordId('SIGWI-x', 'archver-1', 'sig_1', 'proposed');
    const b = deriveConversionRecordId('SIGWI-x', 'archver-1', 'sig_1', 'proposed');
    const c = deriveConversionRecordId('SIGWI-x', 'archver-1', 'sig_1', 'deduplicated');
    const d = deriveConversionRecordId('SIGWI-x', 'archver-1', 'sig_2', 'proposed');
    expect(a).toBe(b);
    expect(a).not.toBe(c); // the decision participates — the honest history
    expect(a).not.toBe(d); // the signal participates
    expect(a).toMatch(/^SIGWIR-[0-9a-f]{24}$/);
  });

  it('ARCHITECTURE VERSION participates in the record identity: the same signal + same decision under two versions are TWO independent records (the PR #107 architect-review fix)', () => {
    // The authoritative Work Item dedup fence is UNIQUE(architecture_version_id,
    // work_item_id): the same logical problem under two versions is TWO
    // governed Work Items — and the decision history must never converge
    // records across versions (a versionless recordId would let one
    // version's ConversionResult reference the OTHER version's Work Item).
    const versionA = deriveConversionRecordId('SIGWI-x', 'archver-1', 'sig_1', 'proposed');
    const versionB = deriveConversionRecordId('SIGWI-x', 'archver-2', 'sig_1', 'proposed');
    expect(versionA).not.toBe(versionB);
    // Idempotency is per-version: re-delivery within EACH version converges.
    expect(deriveConversionRecordId('SIGWI-x', 'archver-2', 'sig_1', 'proposed')).toBe(versionB);
    // Both remain valid SIGWIR identities.
    expect(versionA).toMatch(/^SIGWIR-[0-9a-f]{24}$/);
    expect(versionB).toMatch(/^SIGWIR-[0-9a-f]{24}$/);
  });

  it('the proposal title derivation is deterministic and honest', () => {
    expect(deriveProposalTitle('validation:execution:dependency-blocked-admission')).toBe(
      'Resolve: validation:execution:dependency-blocked-admission',
    );
    expect(deriveProposalTitle('   ')).toBe('Untitled engineering-signal conversion');
  });

  it('the architecture-impact declaration mapping is deterministic (critical/high→high, medium→medium, low→low)', () => {
    expect(deriveArchitectureImpact('critical')).toBe('high');
    expect(deriveArchitectureImpact('high')).toBe('high');
    expect(deriveArchitectureImpact('medium')).toBe('medium');
    expect(deriveArchitectureImpact('low')).toBe('low');
  });
});

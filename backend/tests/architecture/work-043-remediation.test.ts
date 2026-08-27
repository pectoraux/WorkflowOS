/**
 * WORK-043 architecture-remediation regressions.
 *
 * These are intentionally source-level guards for the three architectural
 * boundaries identified in review. They must fail against the current PR #48
 * implementation and pass only after the production seams are corrected.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const policyService = readFileSync(
  new URL('../../src/execution-policy/internal/default-execution-policy-service.ts', import.meta.url),
  'utf8',
);
const policyTypes = readFileSync(
  new URL('../../src/execution-policy/types.ts', import.meta.url),
  'utf8',
);
const handoffService = readFileSync(
  new URL('../../src/modules/agents/internal/default-cross-mode-handoff-service.ts', import.meta.url),
  'utf8',
);
const executionService = readFileSync(
  new URL('../../src/modules/agents/internal/execution-service.ts', import.meta.url),
  'utf8',
);
const executionTypes = readFileSync(
  new URL('../../src/modules/agents/internal/execution.types.ts', import.meta.url),
  'utf8',
);

describe('WORK-043 architecture remediation', () => {
  it('candidate eligibility is observational and cannot create project policy', () => {
    const method = policyService.match(
      /async evaluateCandidateEligibility\([\s\S]*?\n  }\n\n  \/\/ ------------------------------------------------------------------ private/,
    )?.[0] ?? '';
    expect(method).toContain('async evaluateCandidateEligibility');
    expect(method).not.toContain('insertDefaultProjectPolicy(');
  });

  it('candidate eligibility requires authoritative organization scope', () => {
    expect(policyTypes).toMatch(/export interface CandidateEligibilityInput[\s\S]*?readonly organizationId: string;/);
    expect(policyTypes).not.toMatch(/organizationId\?: string \| null/);
    expect(policyService).not.toContain('const organizationId = input.organizationId ?? null;');
  });

  it('cross-mode handoff resolves organization scope from an authoritative project-owned resolver', () => {
    expect(handoffService).toMatch(/interface CrossModeProjectOrganizationResolver/);
    expect(handoffService).toMatch(/organizationResolver: CrossModeProjectOrganizationResolver/);
    expect(handoffService).not.toContain('organizationId: null,');
    expect(handoffService).toMatch(/const organizationId = await this\.deps\.organizationResolver\.getOrganizationId\(record\.projectId\)/);
  });

  it('destination eligibility is a mandatory handoff gate, not an optional compatibility seam', () => {
    expect(handoffService).toMatch(/evaluateCandidateEligibility\(/);
    expect(handoffService).not.toMatch(/evaluateCandidateEligibility\?\(/);
    expect(handoffService).not.toContain('if (!seam)');
  });

  it('execution submission has a distinct admission port before provider dispatch', () => {
    expect(executionTypes).toMatch(/export interface ExecutionAdmissionPort/);
    expect(executionService).toMatch(/readonly executionAdmission: ExecutionAdmissionPort/);
    expect(executionService).toMatch(/await this\.deps\.executionAdmission\.admit\(/);
    const admission = executionService.indexOf('await this.deps.executionAdmission.admit(');
    const providerSubmit = executionService.indexOf('provider.submit(task)');
    expect(admission).toBeGreaterThan(-1);
    expect(providerSubmit).toBeGreaterThan(-1);
    expect(admission).toBeLessThan(providerSubmit);
  });

  it('eligibility and admission are explicitly different contracts', () => {
    expect(executionTypes).toMatch(/interface ExecutionAdmissionPort[\s\S]*?admit\(/);
    expect(policyTypes).toMatch(/evaluateCandidateEligibility\(/);
    expect(executionTypes).not.toContain('ExecutionAdmissionPort extends ExecutionPolicyService');
  });
});

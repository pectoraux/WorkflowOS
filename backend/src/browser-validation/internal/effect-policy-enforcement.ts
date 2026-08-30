/**
 * WORK-065 — the effect-policy enforcement gate (the load-bearing safety
 * invariant of this Work Order).
 *
 * THE CONTRACT (spec/work-orders/WORK-065.md invariant 2-3;
 * spec/architecture/v1.1/validation-model.md §9.4): the browser agent MUST
 * enforce the declared EffectPolicy at execution time, not merely trust the
 * ValidationJourney declaration. Before performing any action, the agent
 * classifies the action's effect and checks it against the run's declared
 * EffectPolicy:
 *
 *   - a READ action is admitted under every policy (READ_ONLY,
 *     SAFE_MUTATION, ISOLATED_MUTATION);
 *   - a MUTATION action is admitted under SAFE_MUTATION and
 *     ISOLATED_MUTATION only — a mutation under READ_ONLY is REJECTED before
 *     execution with a typed effect_policy_violation execution error;
 *   - a FORBIDDEN run (the journey declared EffectPolicy FORBIDDEN) rejects
 *     EVERY action before execution — the browser agent performs no
 *     forbidden actions (the architect-approved safe mechanism is the
 *     WORK-064 admission contract, NOT a browser-execution path);
 *   - an ISOLATED_MUTATION action requires the synthetic identity's tenant
 *     binding to match the environment's isolated tenant — a cross-tenant
 *     mutation is REJECTED before execution.
 *
 * Fail closed: a violation produces a typed effect_policy_violation
 * ExecutionError (recorded by the WORK-064 finalization boundary as the run's
 * outcome — never a silent pass, never a silent healthy).
 *
 * Discrimination-proven: an agent that does NOT enforce the policy (mutating
 * under a READ_ONLY declaration, or performing a FORBIDDEN action) is rejected
 * by the corresponding test, and the test FAILS when the enforcement is
 * removed (see tests/browser-validation/effect-policy-enforcement.test.ts).
 */
import type { EffectPolicy, Environment, TestIdentityBinding, ExecutionError } from '../../continuous-validation/index.js';
import type { BrowserAction } from '../types.js';
import { classifyActionEffect, describeAction } from './browser-action.js';

/** The enforcement decision (explicit, never inferred). */
export interface EffectEnforcementDecision {
  /** True when the action may execute under the run's declared policy. */
  readonly admitted: boolean;
  /** The typed execution error to record when the action is rejected. */
  readonly executionError: ExecutionError | null;
}

/**
 * Decide whether `action` may execute under `policy`, given the run's
 * identity tenant binding and the target environment. Pure, deterministic,
 * side-effect free. Fail closed: every violation produces a typed
 * effect_policy_violation ExecutionError (the WORK-064 finalization boundary
 * records it as the run's outcome — never healthy).
 *
 * The `identity` and `environment` are REQUIRED for ISOLATED_MUTATION
 * cross-tenant enforcement (defense in depth — the WORK-064 admission
 * boundary already verified the tenant match; this re-verifies before the
 * mutation executes).
 */
export function enforceEffectPolicy(
  action: BrowserAction,
  policy: EffectPolicy,
  identity: TestIdentityBinding,
  environment: Environment,
): EffectEnforcementDecision {
  // FORBIDDEN — the browser agent performs NO forbidden actions. The safe
  // mechanism is the WORK-064 admission contract; the agent treats FORBIDDEN
  // as a non-executable class.
  if (policy === 'FORBIDDEN') {
    return {
      admitted: false,
      executionError: {
        kind: 'effect_policy_violation',
        reason: `FORBIDDEN effect policy — the browser agent performs no forbidden actions (${describeAction(action)}; the architect-approved safe mechanism is the WORK-064 admission contract, not a browser-execution path)`,
      },
    };
  }

  const effect = classifyActionEffect(action);

  // READ actions are admitted under every non-FORBIDDEN policy.
  if (effect === 'read') {
    return { admitted: true, executionError: null };
  }

  // MUTATION actions under READ_ONLY — rejected before execution.
  if (policy === 'READ_ONLY') {
    return {
      admitted: false,
      executionError: {
        kind: 'effect_policy_violation',
        reason: `mutation action ${describeAction(action)} is rejected under READ_ONLY policy (READ_ONLY observes state and performs no mutation)`,
      },
    };
  }

  // ISOLATED_MUTATION — cross-tenant mutation is rejected before execution
  // (defense in depth: the WORK-064 admission boundary already verified the
  // tenant match; this re-verifies at execution time).
  if (policy === 'ISOLATED_MUTATION') {
    if (identity.tenantId === null || identity.tenantId === '') {
      return {
        admitted: false,
        executionError: {
          kind: 'effect_policy_violation',
          reason: `ISOLATED_MUTATION action ${describeAction(action)} requires the synthetic identity's test-tenant binding (the identity carries none)`,
        },
      };
    }
    if (
      environment.isolatedTenantId !== null &&
      identity.tenantId !== environment.isolatedTenantId
    ) {
      return {
        admitted: false,
        executionError: {
          kind: 'effect_policy_violation',
          reason: `ISOLATED_MUTATION action ${describeAction(action)} is rejected — the identity's test tenant '${identity.tenantId}' does not match the environment's isolated tenant '${environment.isolatedTenantId}' (cross-tenant isolation)`,
        },
      };
    }
  }

  // SAFE_MUTATION and ISOLATED_MUTATION (with a matching tenant) admit the
  // mutation.
  return { admitted: true, executionError: null };
}

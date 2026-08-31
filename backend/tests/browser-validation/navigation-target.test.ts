import { describe, it, expect } from 'vitest';

/**
 * WORK-065 — the navigation-target safety boundary (PR #97 architect review
 * correction — REQUEST CHANGES).
 *
 * THE DEFECT: the original implementation classified EVERY `navigate` action
 * as a `read` action (admitted under READ_ONLY). That is not safe: a browser
 * navigation can have externally observable side effects even without a DOM
 * mutation (a GET endpoint that mutates, a query string, a non-http(s)
 * scheme, embedded userinfo). "HTTP GET" ≠ "no side effect."
 *
 * THE FIX: the caller EXPLICITLY declares the navigation's effect class
 * (`targetPolicy`), and the agent VERIFIES the declaration against the URL
 * structure before the browser is called. This suite proves every
 * discrimination the architect required:
 *
 *   - READ_ONLY + safe allowed navigation         → executes
 *   - READ_ONLY + disallowed navigation target     → rejected before page.goto()
 *   - unsupported scheme (file:)                    → rejected before page.goto()
 *   - FORBIDDEN + navigate                          → rejected
 *   - SAFE/ISOLATED mutation semantics             → remain unchanged
 *
 * The critical proof: the browser driver is NEVER called for a navigation
 * that the policy boundary rejected (proven in agent-execution.test.ts §14).
 */
import {
  defineValidationJourney,
  describeEnvironment,
  bindTestIdentity,
  type ValidationJourney,
  type Environment,
  type TestIdentitySource,
} from '../../src/continuous-validation/index.js';
import type { AuthenticatedPrincipal } from '@modules/auth/index.js';
import {
  classifyNavigationTarget,
  classifyActionEffect,
  enforceEffectPolicy,
  defineBrowserJourneyPlan,
  type BrowserAction,
} from '../../src/browser-validation/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const syntheticPrincipal: AuthenticatedPrincipal = {
  externalId: 'svc-browser-validation-01',
  label: 'browser validation runner',
  provider: 'apikey',
};
const unauthenticated: TestIdentitySource = { kind: 'unauthenticated' };
const synthetic: TestIdentitySource = {
  kind: 'synthetic',
  principal: syntheticPrincipal,
  principalClass: 'test_service_account',
  capabilities: ['project.read'],
  tenantId: 'tenant-preview',
  issuanceReason: 'PR preview browser validation run',
};
const isolatedSynthetic: TestIdentitySource = {
  kind: 'synthetic',
  principal: syntheticPrincipal,
  principalClass: 'test_service_account',
  capabilities: ['project.read'],
  tenantId: 'tenant-isolated-01',
  issuanceReason: 'isolated mutation browser validation run',
};

const previewEnv: Environment = describeEnvironment({
  id: 'env-preview',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-isolated-01',
});
const isolatedEnv: Environment = describeEnvironment({
  id: 'env-isolated',
  kind: 'isolated',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-isolated-01',
});

// ---------------------------------------------------------------------------
// §1  Navigation-target classification (the explicit, testable boundary)
// ---------------------------------------------------------------------------

describe('WORK-065 navigation-target §1 — classification (the explicit boundary)', () => {
  it('an http(s) URL with no userinfo and no query string, declared read_only_safe → read_only_safe', () => {
    const d = classifyNavigationTarget('https://example.com/sign-in', 'read_only_safe');
    expect(d.targetClass).toBe('read_only_safe');
  });

  it('an http URL (not just https) with no query, declared read_only_safe → read_only_safe', () => {
    const d = classifyNavigationTarget('http://127.0.0.1:5173/sign-in', 'read_only_safe');
    expect(d.targetClass).toBe('read_only_safe');
  });

  it('an http(s) URL WITH a query string, declared read_only_safe → forbidden (GET ≠ read-only; the declaration is provably false)', () => {
    const d = classifyNavigationTarget('https://example.com/unsubscribe?token=abc', 'read_only_safe');
    expect(d.targetClass).toBe('forbidden');
    expect(d.reason).toMatch(/query string/);
    expect(d.reason).toMatch(/read_only_safe/);
  });

  it('an http(s) URL WITH a query string, declared requires_mutation_policy → requires_mutation_policy (honest admission)', () => {
    const d = classifyNavigationTarget('https://example.com/unsubscribe?token=abc', 'requires_mutation_policy');
    expect(d.targetClass).toBe('requires_mutation_policy');
  });

  it('a plain-path URL (no query), declared requires_mutation_policy → requires_mutation_policy (honest — e.g. /delete/123)', () => {
    // A plain-path RESTful GET-mutation like /delete/123: the caller honestly
    // admits the navigation may mutate even though there is no query string.
    // The agent cannot disprove it from the URL alone; the caller's declaration
    // is the authority, and the agent enforces it as a mutation.
    const d = classifyNavigationTarget('https://example.com/delete/123', 'requires_mutation_policy');
    expect(d.targetClass).toBe('requires_mutation_policy');
  });

  it('a file: URL → forbidden regardless of the declaration (unsupported scheme)', () => {
    expect(classifyNavigationTarget('file:///etc/passwd', 'read_only_safe').targetClass).toBe('forbidden');
    expect(classifyNavigationTarget('file:///etc/passwd', 'requires_mutation_policy').targetClass).toBe('forbidden');
  });

  it('a data: URL → forbidden (unsupported scheme)', () => {
    expect(classifyNavigationTarget('data:text/html,<h1>hi</h1>', 'read_only_safe').targetClass).toBe('forbidden');
  });

  it('a javascript: URL → forbidden (unsupported scheme)', () => {
    expect(classifyNavigationTarget('javascript:void(0)', 'read_only_safe').targetClass).toBe('forbidden');
  });

  it('an about: URL → forbidden (unsupported scheme)', () => {
    expect(classifyNavigationTarget('about:blank', 'read_only_safe').targetClass).toBe('forbidden');
  });

  it('a URL with embedded userinfo → forbidden regardless of the declaration', () => {
    expect(classifyNavigationTarget('https://user:pass@example.com/sign-in', 'read_only_safe').targetClass).toBe('forbidden');
    expect(classifyNavigationTarget('https://user:pass@example.com/sign-in', 'requires_mutation_policy').targetClass).toBe('forbidden');
  });

  it('an unparseable / empty URL → forbidden', () => {
    expect(classifyNavigationTarget('', 'read_only_safe').targetClass).toBe('forbidden');
    expect(classifyNavigationTarget('not-a-url', 'read_only_safe').targetClass).toBe('forbidden');
  });

  it('a URL with a fragment (#) but no query string, declared read_only_safe → read_only_safe (fragments are client-side only)', () => {
    // A fragment does not cause a request and carries no mutation semantics.
    const d = classifyNavigationTarget('https://example.com/sign-in#section', 'read_only_safe');
    expect(d.targetClass).toBe('read_only_safe');
  });
});

// ---------------------------------------------------------------------------
// §2  Effect-policy enforcement for navigate (the discriminations)
// ---------------------------------------------------------------------------

describe('WORK-065 navigation-target §2 — enforcement (the discriminations)', () => {
  const readIdentity = bindTestIdentity(unauthenticated, previewEnv, 'READ_ONLY');
  const mutationIdentity = bindTestIdentity(synthetic, previewEnv, 'SAFE_MUTATION');
  const isolatedIdentity = bindTestIdentity(isolatedSynthetic, isolatedEnv, 'ISOLATED_MUTATION');
  const forbiddenIdentity = bindTestIdentity(synthetic, previewEnv, 'SAFE_MUTATION');

  it('READ_ONLY + a safe allowed navigation (http, no query, read_only_safe) → ADMITTED (executes)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/sign-in', targetPolicy: 'read_only_safe' };
    const d = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv);
    expect(d.admitted).toBe(true);
    expect(d.executionError).toBeNull();
  });

  it('READ_ONLY + a disallowed navigation target (query string, requires_mutation_policy) → REJECTED before page.goto()', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/unsubscribe?token=abc', targetPolicy: 'requires_mutation_policy' };
    const d = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv);
    expect(d.admitted).toBe(false);
    expect(d.executionError).not.toBeNull();
    expect(d.executionError!.kind).toBe('effect_policy_violation');
    expect(d.executionError!.reason).toMatch(/requires a mutation policy/);
  });

  it('READ_ONLY + a plain-path navigation declared requires_mutation_policy (e.g. /delete/123) → REJECTED (the caller honestly admits it may mutate)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/delete/123', targetPolicy: 'requires_mutation_policy' };
    const d = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv);
    expect(d.admitted).toBe(false);
    expect(d.executionError!.kind).toBe('effect_policy_violation');
    expect(d.executionError!.reason).toMatch(/requires a mutation policy/);
  });

  it('READ_ONLY + a query-string URL declared read_only_safe → REJECTED (the declaration is provably false — forbidden)', () => {
    // The caller lied: a query string MAY mutate, but the caller declared
    // read_only_safe. The agent rejects it before the browser is called,
    // regardless of the run's policy (forbidden target).
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/?action=delete', targetPolicy: 'read_only_safe' };
    const d = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv);
    expect(d.admitted).toBe(false);
    expect(d.executionError!.kind).toBe('effect_policy_violation');
    expect(d.executionError!.reason).toMatch(/forbidden/);
  });

  it('unsupported scheme (file:) → REJECTED before page.goto() under EVERY policy (forbidden target)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'file:///etc/passwd', targetPolicy: 'read_only_safe' };
    // Rejected under READ_ONLY:
    expect(enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv).admitted).toBe(false);
    // Rejected under SAFE_MUTATION:
    expect(enforceEffectPolicy(nav, 'SAFE_MUTATION', mutationIdentity, previewEnv).admitted).toBe(false);
    // Rejected under ISOLATED_MUTATION:
    expect(enforceEffectPolicy(nav, 'ISOLATED_MUTATION', isolatedIdentity, isolatedEnv).admitted).toBe(false);
    // The reason is 'forbidden' (not 'requires a mutation policy'):
    const d = enforceEffectPolicy(nav, 'SAFE_MUTATION', mutationIdentity, previewEnv);
    expect(d.executionError!.reason).toMatch(/forbidden/);
    expect(d.executionError!.reason).toMatch(/file:/);
  });

  it('embedded userinfo → REJECTED before page.goto() under every policy (forbidden target)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://user:pass@example.com/sign-in', targetPolicy: 'read_only_safe' };
    expect(enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv).admitted).toBe(false);
    expect(enforceEffectPolicy(nav, 'SAFE_MUTATION', mutationIdentity, previewEnv).admitted).toBe(false);
  });

  it('FORBIDDEN + navigate → REJECTED (the browser agent performs no forbidden actions, including navigation)', () => {
    // Even a safe navigation target is rejected under a FORBIDDEN run.
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/sign-in', targetPolicy: 'read_only_safe' };
    const d = enforceEffectPolicy(nav, 'FORBIDDEN', forbiddenIdentity, previewEnv);
    expect(d.admitted).toBe(false);
    expect(d.executionError!.kind).toBe('effect_policy_violation');
    expect(d.executionError!.reason).toMatch(/FORBIDDEN/);
  });

  it('SAFE_MUTATION + a navigation declared requires_mutation_policy (query string) → ADMITTED', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/save?name=value', targetPolicy: 'requires_mutation_policy' };
    const d = enforceEffectPolicy(nav, 'SAFE_MUTATION', mutationIdentity, previewEnv);
    expect(d.admitted).toBe(true);
    expect(d.executionError).toBeNull();
  });

  it('ISOLATED_MUTATION + a navigation declared requires_mutation_policy → ADMITTED (with a matching tenant)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/save?name=value', targetPolicy: 'requires_mutation_policy' };
    const d = enforceEffectPolicy(nav, 'ISOLATED_MUTATION', isolatedIdentity, isolatedEnv);
    expect(d.admitted).toBe(true);
  });

  it('SAFE_MUTATION + a navigation declared read_only_safe (plain path) → ADMITTED (read_only_safe is admitted under every non-FORBIDDEN policy)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/dashboard', targetPolicy: 'read_only_safe' };
    const d = enforceEffectPolicy(nav, 'SAFE_MUTATION', mutationIdentity, previewEnv);
    expect(d.admitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3  SAFE/ISOLATED mutation semantics remain unchanged (click/type)
// ---------------------------------------------------------------------------

describe('WORK-065 navigation-target §3 — SAFE/ISOLATED mutation semantics unchanged (click/type)', () => {
  const readIdentity = bindTestIdentity(unauthenticated, previewEnv, 'READ_ONLY');
  const mutationIdentity = bindTestIdentity(synthetic, previewEnv, 'SAFE_MUTATION');
  const isolatedIdentity = bindTestIdentity(isolatedSynthetic, isolatedEnv, 'ISOLATED_MUTATION');

  it('click under READ_ONLY → REJECTED (unchanged)', () => {
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    expect(enforceEffectPolicy(click, 'READ_ONLY', readIdentity, previewEnv).admitted).toBe(false);
  });

  it('type under READ_ONLY → REJECTED (unchanged)', () => {
    const type: BrowserAction = { kind: 'type', selector: 'input', text: 'hello' };
    expect(enforceEffectPolicy(type, 'READ_ONLY', readIdentity, previewEnv).admitted).toBe(false);
  });

  it('click under SAFE_MUTATION → ADMITTED (unchanged)', () => {
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    expect(enforceEffectPolicy(click, 'SAFE_MUTATION', mutationIdentity, previewEnv).admitted).toBe(true);
  });

  it('type under SAFE_MUTATION → ADMITTED (unchanged)', () => {
    const type: BrowserAction = { kind: 'type', selector: 'input', text: 'hello' };
    expect(enforceEffectPolicy(type, 'SAFE_MUTATION', mutationIdentity, previewEnv).admitted).toBe(true);
  });

  it('click under ISOLATED_MUTATION (matching tenant) → ADMITTED (unchanged)', () => {
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    expect(enforceEffectPolicy(click, 'ISOLATED_MUTATION', isolatedIdentity, isolatedEnv).admitted).toBe(true);
  });

  it('extract/screenshot remain classified as read (unchanged)', () => {
    expect(classifyActionEffect({ kind: 'extract', selector: 'h1', satisfiesObservationId: 'x' })).toBe('read');
    expect(classifyActionEffect({ kind: 'screenshot' })).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// §4  Plan construction: navigate without targetPolicy is rejected
// ---------------------------------------------------------------------------

describe('WORK-065 navigation-target §4 — plan construction requires targetPolicy on navigate', () => {
  const journey: ValidationJourney = defineValidationJourney({
    id: 'journey-nav-targetPolicy',
    name: 'A journey',
    identityRequirement: 'unauthenticated',
    allowedModes: ['PRE_MERGE'],
    effectPolicy: 'READ_ONLY',
    steps: [
      {
        id: 'step-open',
        name: 'open',
        expectedObservations: [
          { id: 'obs-status', stepId: 'step-open', kind: 'network', description: 'page loaded', matcher: { kind: 'status_code', status: 200 } },
        ],
      },
    ],
    successCriteria: [{ id: 'crit', description: 'page loads', requiresObservationIds: ['obs-status'] }],
  });

  it('a navigate WITHOUT targetPolicy is rejected by the plan constructor (the caller must answer the safety question)', () => {
    expect(() =>
      defineBrowserJourneyPlan(
        {
          journeyId: journey.id,
          steps: [
            {
              stepId: 'step-open',
              actions: [
                // @ts-expect-error — missing targetPolicy on purpose
                { kind: 'navigate', url: 'https://example.com', satisfiesObservationId: 'obs-status' },
              ],
            },
          ],
        },
        journey,
      ),
    ).toThrow(/targetPolicy/);
  });

  it('a navigate WITH targetPolicy is accepted', () => {
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: journey.id,
        steps: [
          {
            stepId: 'step-open',
            actions: [
              { kind: 'navigate', url: 'https://example.com', targetPolicy: 'read_only_safe', satisfiesObservationId: 'obs-status' },
            ],
          },
        ],
      },
      journey,
    );
    expect(plan.steps).toHaveLength(1);
  });
});

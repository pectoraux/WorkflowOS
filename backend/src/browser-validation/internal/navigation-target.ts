/**
 * WORK-065 — the navigation target safety boundary.
 *
 * THE DEFECT THIS MODULE FIXES (PR #97 architect review — REQUEST CHANGES):
 * the original implementation classified EVERY `navigate` action as a `read`
 * action (admitted under READ_ONLY). That is not a safe guarantee at the
 * browser-execution boundary. A browser navigation can have externally
 * observable side effects even without a DOM mutation:
 *
 *   - a GET endpoint that performs state changes (e.g. `?action=delete`,
 *     a one-time token consumption, an unsubscription link);
 *   - a download/navigation chain that hits internal services;
 *   - effects outside the target application's DOM.
 *
 * "HTTP GET" ≠ "no side effect." The model must answer the question:
 *
 *   **What makes a navigation READ_ONLY-safe?**
 *
 * THE ANSWER (the explicit, testable boundary):
 *
 *   A navigation is `read_only_safe` ONLY when BOTH hold:
 *     1. the caller EXPLICITLY declares `targetPolicy: 'read_only_safe'`
 *        (the caller's honest assertion that the navigation observes state
 *        and performs no mutation); AND
 *     2. the URL structure VERIFIES the declaration — the scheme is http(s),
 *        there is NO embedded userinfo, and there is NO query string (a query
 *        string is the canonical signal that a GET MAY mutate; a declared
 *        `read_only_safe` navigation whose URL carries a query string is
 *        PROVABLY FALSE and rejected before the browser is called).
 *
 *   A navigation is `requires_mutation_policy` when the caller declares
 *   `targetPolicy: 'requires_mutation_policy'` (the caller honestly admits
 *   the navigation may mutate — e.g. a plain-path RESTful GET-mutation like
 *   `/delete/123`, or any URL with a query string). The agent admits it under
 *   SAFE_MUTATION / ISOLATED_MUTATION only; READ_ONLY rejects it.
 *
 *   A navigation is `forbidden` when the URL structure is categorically
 *   rejected regardless of the declaration — a non-http(s) scheme (file:,
 *   data:, javascript:, about:, blob:, …) or embedded userinfo. The agent
 *   rejects it under EVERY policy before the browser is called.
 *
 * THE CALLER-DECLARES + AGENT-VERIFIES MODEL:
 *   - the caller declares the navigation's effect class (`targetPolicy`);
 *   - the agent VERIFIES the declaration against the URL structure (a
 *     `read_only_safe` declaration for a URL with a query string is rejected
 *     — the caller lied; the declaration is provably false);
 *   - the agent ENFORCES the verified class against the run's declared
 *     EffectPolicy.
 *
 * This is discrimination-proven: removing the verification (trusting a
 * `read_only_safe` declaration for a query-string URL) lets the navigation
 * through under READ_ONLY — the corresponding test FAILS.
 *
 * Defense in depth: the {@link PlaywrightBrowserDriver} ALSO validates the URL
 * scheme + userinfo before `page.goto()` (the documented "http(s) URLs only"
 * guarantee made real). The gate is the primary enforcement; the driver is the
 * backstop.
 */

/** The closed navigation-target safety classification. */
export type NavigationTargetClass =
  | 'read_only_safe'
  | 'requires_mutation_policy'
  | 'forbidden';

/**
 * The caller's declaration of a navigation's effect class. Carried on the
 * `navigate` action ({@link BrowserAction}); verified by the agent against
 * the URL structure.
 */
export type NavigationTargetPolicy = 'read_only_safe' | 'requires_mutation_policy';

/** The deterministic classification decision (explicit, never inferred). */
export interface NavigationTargetDecision {
  readonly targetClass: NavigationTargetClass;
  readonly reason: string;
}

/**
 * Classify a navigation target. Pure, deterministic, side-effect free. Fail
 * closed: every ambiguous or provably-false case produces `forbidden` (the
 * agent rejects it before the browser is called).
 *
 * Evaluation order:
 *   1. URL parseability + scheme (non-http(s) → forbidden);
 *   2. embedded userinfo (→ forbidden);
 *   3. query string + declared `read_only_safe` (provably false → forbidden);
 *   4. query string + declared `requires_mutation_policy` (honest → requires_mutation_policy);
 *   5. no query string → trust the caller's declaration.
 */
export function classifyNavigationTarget(
  url: string,
  declaredPolicy: NavigationTargetPolicy,
): NavigationTargetDecision {
  if (typeof url !== 'string' || url.trim() === '') {
    return {
      targetClass: 'forbidden',
      reason: 'navigation url must be a non-empty string',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      targetClass: 'forbidden',
      reason: `navigation url is not parseable: ${JSON.stringify(url)}`,
    };
  }
  // 1. The scheme MUST be http(s). file:, data:, javascript:, about:, blob:,
  //    etc. are categorically forbidden — a navigation to them is rejected
  //    under every policy before the browser is called.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      targetClass: 'forbidden',
      reason: `navigation url scheme '${parsed.protocol}' is not http(s) — the browser agent rejects unsupported schemes before page.goto()`,
    };
  }
  // 2. Embedded userinfo (username:password@) is forbidden — a navigation
  //    must not carry credentials in the URL.
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      targetClass: 'forbidden',
      reason: 'navigation url must not embed userinfo (username:password@) — the browser agent rejects userinfo before page.goto()',
    };
  }
  // 3. A query string MAY carry mutation semantics (?action=delete, a
  //    one-time token, …). "HTTP GET" ≠ "no side effect." A query string is
  //    the canonical signal that a GET MAY mutate.
  const hasQuery = parsed.search !== '';
  if (hasQuery && declaredPolicy === 'read_only_safe') {
    // The caller declared read_only_safe, but the URL carries a query string
    // — the declaration is PROVABLY FALSE. Reject it before the browser is
    //    called (the caller must re-declare requires_mutation_policy and the
    //    run must admit it under SAFE_MUTATION / ISOLATED_MUTATION).
    return {
      targetClass: 'forbidden',
      reason: `navigation url carries a query string ('${parsed.search}') that may have side effects — the caller declared targetPolicy 'read_only_safe' but GET ≠ read-only; the declaration is provably false and the navigation is rejected before page.goto()`,
    };
  }
  if (hasQuery) {
    // declaredPolicy === 'requires_mutation_policy' — the caller honestly
    // admits the navigation may mutate. The agent enforces it as a mutation
    // (admitted under SAFE_MUTATION / ISOLATED_MUTATION; rejected under
    // READ_ONLY).
    return {
      targetClass: 'requires_mutation_policy',
      reason: `navigation url carries a query string ('${parsed.search}') — the caller declared targetPolicy 'requires_mutation_policy' (GET may mutate); requires SAFE_MUTATION or ISOLATED_MUTATION`,
    };
  }
  // 4. No query string — the URL structure does not contradict the caller's
  //    declaration. Trust the caller's declared policy (a plain-path
  //    navigation declared 'requires_mutation_policy' is the caller's honest
  //    admission that the path may mutate, e.g. /delete/123; a plain-path
  //    navigation declared 'read_only_safe' is the caller's assertion that
  //    the page load observes state and performs no mutation).
  if (declaredPolicy === 'requires_mutation_policy') {
    return {
      targetClass: 'requires_mutation_policy',
      reason: `navigation target is an http(s) URL with no query string — the caller declared targetPolicy 'requires_mutation_policy' (the navigation may mutate); requires SAFE_MUTATION or ISOLATED_MUTATION`,
    };
  }
  return {
    targetClass: 'read_only_safe',
    reason: 'navigation target is an http(s) URL with no userinfo and no query string — the caller declared targetPolicy \'read_only_safe\' and the URL structure verifies it (read-only-safe)',
  };
}

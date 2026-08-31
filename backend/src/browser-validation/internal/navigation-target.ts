/**
 * WORK-065 — the navigation target safety boundary (the AUTHORITATIVE model).
 *
 * THE DEFECT THIS MODULE FIXES (PR #97 second architect review — REQUEST
 * CHANGES): the first correction introduced a per-action `targetPolicy`
 * field and verified it against the URL structure. But the architect correctly
 * identified that this still did NOT close the original safety defect:
 *
 *   - a plain-path GET like `/delete/123` with `targetPolicy: 'read_only_safe'`
 *     and no query string was still classified as `read_only_safe` and admitted
 *     under READ_ONLY;
 *   - the agent cannot know whether a target GET mutates server state merely
 *     from the URL structure — "no query string" is not proof of safety, and
 *     "query string" is not proof of mutation;
 *   - the per-action `targetPolicy` was an **executor-supplied assertion**, and
 *     the agent was turning that assertion into authoritative safety.
 *
 * THE INVARIANT (the architect's ruling):
 *
 *   > The browser executor must not turn an executor-supplied assertion into
 *   > authoritative safety.
 *
 * THE AUTHORITATIVE MODEL (the fix):
 *
 *   A navigation is `read_only_safe` ONLY when the URL is in the plan's
 *   AUTHORITATIVE `readonlySafeNavigationTargets` allowlist — the journey's
 *   TRUSTED declaration of which navigation targets are read-only-safe. The
 *   allowlist is declared on the {@link BrowserJourneyPlan} (the execution
 *   plan derived from the journey under WORK-064's authority), NOT on the
 *   per-action `navigate` field. There is NO per-action safety assertion —
 *   the executor cannot assert safety; the journey declares it.
 *
 * Classification:
 *
 *   - `forbidden` — the URL has a non-http(s) scheme or embedded userinfo
 *     (categorically rejected under EVERY policy, regardless of the allowlist
 *     — syntactic safety, defense in depth);
 *   - `read_only_safe` — the URL is http(s), no userinfo, AND is in the
 *     allowlist (the journey authoritatively declared it read-only-safe);
 *   - `unverified` — the URL is http(s), no userinfo, but NOT in the allowlist
 *     (the agent has no authoritative proof of safety). Under READ_ONLY it is
 *     REJECTED (no proof of safety); under SAFE_MUTATION / ISOLATED_MUTATION
 *     it is admitted (the run has a mutation policy, so a potentially-mutating
 *     navigation is within policy).
 *
 * An empty allowlist means NO navigation is proven read-only-safe (the safe
 * default — every navigate under READ_ONLY is rejected).
 *
 * This is discrimination-proven: the attack shape `GET /delete/123` with
 * (the now-removed) `targetPolicy: 'read_only_safe'` under READ_ONLY is
 * REJECTED because `/delete/123` is not in the allowlist (unverified). The
 * corresponding test FAILS if the allowlist check is removed.
 */
/** The closed navigation-target safety classification. */
export type NavigationTargetClass =
  | 'read_only_safe'
  | 'unverified'
  | 'forbidden';

/** The deterministic classification decision (explicit, never inferred). */
export interface NavigationTargetDecision {
  readonly targetClass: NavigationTargetClass;
  readonly reason: string;
}

/**
 * Validate that an allowlist entry is a parseable http(s) URL with no embedded
 * userinfo. Used by the plan constructor to validate each
 * `readonlySafeNavigationTargets` entry at plan construction (an invalid
 * allowlist entry is rejected — the trusted declaration must be syntactically
 * safe). Returns null when valid, or the violation reason when invalid.
 */
export function validateAllowlistEntry(url: string): string | null {
  if (typeof url !== 'string' || url.trim() === '') {
    return 'allowlist entry must be a non-empty string';
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `allowlist entry ${JSON.stringify(url)} is not a parseable URL`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `allowlist entry ${JSON.stringify(url)} scheme '${parsed.protocol}' is not http(s) — the trusted declaration must be syntactically safe`;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return `allowlist entry ${JSON.stringify(url)} embeds userinfo — the trusted declaration must not carry credentials`;
  }
  return null;
}

/**
 * Classify a navigation target against the plan's authoritative allowlist.
 * Pure, deterministic, side-effect free. Fail closed: every ambiguous or
 * unverified case produces `unverified` (admitted only under a mutation
 * policy); every syntactically-unsafe case produces `forbidden` (rejected
 * under every policy).
 *
 * THE AUTHORITATIVE BOUNDARY: a navigation is `read_only_safe` ONLY when the
 * URL is in the allowlist (the journey's trusted declaration). The URL
 * structure (scheme/userinfo) is a defense-in-depth syntactic check — it
 * cannot prove safety on its own (a plain-path GET may still mutate).
 *
 * @param url the navigate action's target URL
 * @param allowlist the plan's authoritative readonlySafeNavigationTargets
 */
export function classifyNavigationTarget(
  url: string,
  allowlist: readonly string[],
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
  // 1. Non-http(s) scheme → forbidden (categorically rejected under every
  //    policy, regardless of the allowlist — syntactic safety).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      targetClass: 'forbidden',
      reason: `navigation url scheme '${parsed.protocol}' is not http(s) — the browser agent rejects unsupported schemes before page.goto()`,
    };
  }
  // 2. Embedded userinfo → forbidden (a navigation must not carry credentials).
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      targetClass: 'forbidden',
      reason: 'navigation url must not embed userinfo (username:password@) — the browser agent rejects userinfo before page.goto()',
    };
  }
  // 3. THE AUTHORITATIVE CHECK: the URL must be in the plan's
  //    readonlySafeNavigationTargets allowlist to be proven read-only-safe.
  //    The executor CANNOT assert safety — the journey declares it. A URL not
  //    in the allowlist is `unverified` (no authoritative proof of safety):
  //    under READ_ONLY it is REJECTED; under SAFE_MUTATION / ISOLATED_MUTATION
  //    it is admitted (the run has a mutation policy).
  const allowlistSet = new Set(allowlist);
  if (allowlistSet.has(url)) {
    return {
      targetClass: 'read_only_safe',
      reason: 'navigation target is in the plan\'s authoritative readonlySafeNavigationTargets allowlist (the journey\'s trusted declaration of read-only-safe targets)',
    };
  }
  return {
    targetClass: 'unverified',
    reason: `navigation target ${JSON.stringify(url)} is NOT in the plan's readonlySafeNavigationTargets allowlist — the agent has no authoritative proof that this GET does not mutate server state; under READ_ONLY it is rejected (the executor cannot assert safety; the journey must declare the target read-only-safe)`,
  };
}

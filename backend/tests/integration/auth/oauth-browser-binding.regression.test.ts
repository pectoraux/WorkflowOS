import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildRuntimeStack,
  buildRuntimeServer,
  buildMockGoogleProvider,
  mockOAuthHttpClient,
  type TestRuntimeStack,
} from '../../helpers/test-identity-runtime-stack.js';

/**
 * WORK-074 (OAuth browser-binding hardening) — the deterministic cross-browser
 * + replay regression.
 *
 * The OAuth `state` parameter alone is NOT sufficient: it proves only that the
 * browser presenting the callback once saw the redirect. It does NOT prove a
 * durable correlation to a distinct login transaction, and it offers NO
 * one-time-use (replay) protection. The runtime now stores the pending flow
 * server-side (wfos_oauth_pending_flows), bound to a browser-binding secret
 * (the wfos_oauth_flow httpOnly cookie — the server stores only its SHA-256
 * digest). The callback verifies the browser-binding matches AND atomically
 * consumes the flow (one-time-use).
 *
 * Deterministic proof (the architect's required matrix):
 *
 *   Browser A starts OAuth        → pending flow P_A created, bound to A's cookie
 *   Browser B presents A's state → REJECTED (browser-binding mismatch), no session
 *   Browser A completes callback → SUCCESS, session created
 *   Replay same callback         → REJECTED (flow already consumed), no new session
 *
 * On real PostgreSQL (pglite locally / real pg in CI). The atomic consume
 * (UPDATE ... WHERE consumed_at IS NULL) ensures exactly one winner under
 * concurrent replay — proven by the concurrent-replay test below.
 */
describe('WORK-074 — OAuth browser-binding: cross-browser + replay regression', () => {
  let stack: TestRuntimeStack;
  let server: Awaited<ReturnType<typeof buildRuntimeServer>>;
  const googleSubject = 'google-sub-xbrowser-001';
  const googleEmail = 'xbrowser@example.com';

  beforeAll(async () => {
    stack = await buildRuntimeStack();
    const { provider } = buildMockGoogleProvider(
      stack.secretStore,
      {},
      mockOAuthHttpClient({ subject: googleSubject, email: googleEmail, name: 'XBrowser User' }),
    );
    server = await buildRuntimeServer(stack, { oauthProviders: { google: provider } });
  });
  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  /** Start an OAuth flow; return the redirect URL (contains state) + the flow cookie. */
  async function startFlow(): Promise<{ location: string; flowCookie: string }> {
    const res = await server.app.inject({ method: 'GET', url: '/auth/login/google' });
    expect(res.statusCode).toBe(302);
    const location = res.headers['location'] as string;
    expect(location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    const setCookie = res.headers['set-cookie'] as string;
    const flowCookie = extractCookieValue(setCookie, 'wfos_oauth_flow');
    expect(flowCookie).toBeTruthy();
    return { location, flowCookie: flowCookie! };
  }

  /** Extract the `state` query param from the provider redirect URL. */
  function extractState(location: string): string {
    const url = new URL(location);
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    return state!;
  }

  /** Build a callback cookie header from a flow cookie value. */
  function cookieHeaderFor(flowCookie: string | null): Record<string, string> {
    return flowCookie ? { cookie: `wfos_oauth_flow=${flowCookie}` } : {};
  }

  // -------------------------------------------------------------------------
  // The deterministic matrix.
  // -------------------------------------------------------------------------

  it('Browser A starts OAuth → pending flow P_A created, bound to A\'s cookie', async () => {
    const { location, flowCookie } = await startFlow();
    const state = extractState(location);
    // The pending flow exists server-side, bound to the browser-binding digest.
    const flow = await stack.oauthPendingFlows.findByState(state);
    expect(flow).not.toBeNull();
    expect(flow!.provider).toBe('google');
    expect(flow!.consumedAt).toBeNull();
    expect(flow!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // The raw browser-binding secret is NEVER stored — only its digest.
    expect(flow!.browserBinding).toMatch(/^[0-9a-f]{64}$/);
    expect(flow!.browserBinding).not.toBe(flowCookie);
  });

  let browserA_state: string;
  let browserA_flowCookie: string;

  it('Browser A starts OAuth (capture for the cross-browser + replay tests)', async () => {
    const { location, flowCookie } = await startFlow();
    browserA_state = extractState(location);
    browserA_flowCookie = flowCookie;
  });

  it('Browser B presents A\'s state+code (with B\'s OWN flow cookie) → REJECTED, no session', async () => {
    // Browser B starts its OWN flow (different cookie) — but presents A's
    // state+code. Browser B's flow cookie does not match P_A's browser_binding.
    const { flowCookie: browserBFlowCookie } = await startFlow();
    expect(browserBFlowCookie).not.toBe(browserA_flowCookie);
    const res = await server.app.inject({
      method: 'GET',
      url: `/auth/callback/google?code=mock-code&state=${browserA_state}`,
      headers: cookieHeaderFor(browserBFlowCookie),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; reason: string };
    expect(body.error).toBe('invalid-callback');
    expect(body.reason).toBe('browser-mismatch');
    // No session was created — /auth/me with no cookie is 401.
    const me = await server.app.inject({ method: 'GET', url: '/auth/me' });
    expect(me.statusCode).toBe(401);
  });

  it('Browser B presents A\'s state+code with NO flow cookie → REJECTED, no session', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: `/auth/callback/google?code=mock-code&state=${browserA_state}`,
      headers: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; reason: string };
    expect(body.error).toBe('invalid-callback');
    expect(body.reason).toBe('missing-browser-binding');
  });

  it('Browser A completes its OWN callback (A\'s flow cookie matches) → SUCCESS, session created', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: `/auth/callback/google?code=mock-code&state=${browserA_state}`,
      headers: cookieHeaderFor(browserA_flowCookie),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/');
    // The session cookie was set.
    const sessionCookie = extractCookieValue(res.headers['set-cookie'] as string, 'wfos_session');
    expect(sessionCookie).toBeTruthy();
    // /auth/me with the session cookie resolves the user.
    const me = await server.app.inject({
      method: 'GET', url: '/auth/me',
      headers: { cookie: `wfos_session=${sessionCookie}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as { kind: string; user: { email: string } };
    expect(meBody.kind).toBe('human');
    expect(meBody.user.email).toBe(googleEmail);
  });

  it('Replay: Browser A presents the SAME callback again (same state+code+cookie) → REJECTED (already consumed), no new session', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: `/auth/callback/google?code=mock-code&state=${browserA_state}`,
      headers: cookieHeaderFor(browserA_flowCookie),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; reason: string };
    expect(body.error).toBe('invalid-callback');
    expect(body.reason).toBe('replay');
    // The pending flow is now consumed.
    const flow = await stack.oauthPendingFlows.findByState(browserA_state);
    expect(flow).not.toBeNull();
    expect(flow!.consumedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Edge cases (the typed denials).
  // -------------------------------------------------------------------------

  it('an unknown state (no pending flow) → REJECTED with reason "unknown"', async () => {
    const { flowCookie } = await startFlow();
    const res = await server.app.inject({
      method: 'GET',
      url: `/auth/callback/google?code=mock-code&state=not-a-real-state`,
      headers: cookieHeaderFor(flowCookie),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { reason: string }).reason).toBe('unknown');
  });

  it('a missing code or state → REJECTED (400, missing-code-or-state)', async () => {
    const { flowCookie } = await startFlow();
    const res = await server.app.inject({
      method: 'GET',
      url: `/auth/callback/google?code=mock-code`,
      headers: cookieHeaderFor(flowCookie),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { reason: string }).reason).toBe('missing-code-or-state');
  });

  it('the raw browser-binding secret is NEVER stored server-side (SEC-AC-02)', async () => {
    const { flowCookie } = await startFlow();
    // The cookie holds the raw secret.
    expect(flowCookie.length).toBeGreaterThan(40);
    // The DB stores ONLY the digest.
    const rows = await stack.db.client.query<{ browser_binding: string }>(
      'SELECT browser_binding FROM wfos_oauth_pending_flows ORDER BY created_at DESC LIMIT 1',
    );
    const stored = rows.rows[0]!.browser_binding;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(flowCookie);
    // The raw secret does not appear anywhere in the table.
    const allCols = await stack.db.client.query(
      'SELECT state, provider, browser_binding FROM wfos_oauth_pending_flows',
    );
    const json = JSON.stringify(allCols.rows);
    expect(json).not.toContain(flowCookie);
  });

  // -------------------------------------------------------------------------
  // Concurrent replay — exactly one consumer wins (the atomic consume).
  // -------------------------------------------------------------------------
  it('concurrent replay: two simultaneous callbacks for the same flow → exactly ONE wins, the other is rejected', async () => {
    const { location, flowCookie } = await startFlow();
    const state = extractState(location);
    // Fire two callbacks in parallel (same state, same cookie, same code).
    const [r1, r2] = await Promise.all([
      server.app.inject({
        method: 'GET', url: `/auth/callback/google?code=mock-code&state=${state}`,
        headers: cookieHeaderFor(flowCookie),
      }),
      server.app.inject({
        method: 'GET', url: `/auth/callback/google?code=mock-code&state=${state}`,
        headers: cookieHeaderFor(flowCookie),
      }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    // Exactly one succeeds (302); the other is rejected (400, replay).
    expect(codes).toEqual([302, 400]);
    // The flow is consumed exactly once.
    const flow = await stack.oauthPendingFlows.findByState(state);
    expect(flow).not.toBeNull();
    expect(flow!.consumedAt).not.toBeNull();
  });
});

/** Extract a named cookie value from a Set-Cookie header. */
function extractCookieValue(setCookie: string | string[] | undefined, name: string): string | null {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const prefix = `${name}=`;
  for (const h of headers) {
    if (h.startsWith(prefix)) {
      return decodeURIComponent(h.slice(prefix.length).split(';')[0]!);
    }
  }
  return null;
}

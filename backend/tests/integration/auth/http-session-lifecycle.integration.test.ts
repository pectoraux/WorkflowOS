import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildRuntimeStack,
  buildRuntimeServer,
  type TestRuntimeStack,
} from '../../helpers/test-identity-runtime-stack.js';

/**
 * WORK-074 — HTTP-level proofs: login, logout, session persistence, protected
 * route rejection, expired/invalid session, /auth/me, cross-tenant denial.
 *
 * Exercises the real Fastify server with cookie-based sessions (the runtime
 * wired end-to-end). The dogfooding-gate auth precondition (proof #15) is the
 * browser E2E; these HTTP proofs are the server-side backbone it relies on.
 */
describe('WORK-074 — HTTP session lifecycle + protected routes', () => {
  let stack: TestRuntimeStack;
  let server: Awaited<ReturnType<typeof buildRuntimeServer>>;

  beforeAll(async () => {
    stack = await buildRuntimeStack();
    server = await buildRuntimeServer(stack);
  });
  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  /** Extract the session cookie value from a Set-Cookie header. */
  function extractCookie(setCookie: string | string[] | undefined, name: string): string | null {
    const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const h of headers) {
      const prefix = `${name}=`;
      if (h.startsWith(prefix)) {
        return decodeURIComponent(h.slice(prefix.length).split(';')[0]!);
      }
    }
    return null;
  }

  it('unauthenticated: GET /auth/me returns 401', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('email signup sets a session cookie + GET /auth/me resolves the user', async () => {
    const res = await server.app.inject({
      method: 'POST', url: '/auth/signup/email',
      payload: { email: 'http1@example.com', password: 'p@ssw0rd-http1', displayName: 'Http1' },
    });
    expect(res.statusCode).toBe(201);
    const cookie = extractCookie(res.headers['set-cookie'], 'wfos_session');
    expect(cookie).toBeTruthy();

    // GET /auth/me with the cookie resolves the user (session persistence).
    const me = await server.app.inject({
      method: 'GET', url: '/auth/me',
      headers: { cookie: `wfos_session=${cookie}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { kind: string; user: { email: string } };
    expect(body.kind).toBe('human');
    expect(body.user.email).toBe('http1@example.com');
  });

  it('email login sets a session cookie; logout revokes it', async () => {
    // Signup first.
    await server.app.inject({
      method: 'POST', url: '/auth/signup/email',
      payload: { email: 'http2@example.com', password: 'p@ssw0rd-http2' },
    });
    // Login.
    const login = await server.app.inject({
      method: 'POST', url: '/auth/login/email',
      payload: { email: 'http2@example.com', password: 'p@ssw0rd-http2' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = extractCookie(login.headers['set-cookie'], 'wfos_session');
    expect(cookie).toBeTruthy();

    // The session works.
    const me1 = await server.app.inject({
      method: 'GET', url: '/auth/me', headers: { cookie: `wfos_session=${cookie}` },
    });
    expect(me1.statusCode).toBe(200);

    // Logout revokes the session.
    const logout = await server.app.inject({
      method: 'POST', url: '/auth/logout', headers: { cookie: `wfos_session=${cookie}` },
    });
    expect(logout.statusCode).toBe(204);

    // After logout, the SAME cookie is rejected (revoked).
    const me2 = await server.app.inject({
      method: 'GET', url: '/auth/me', headers: { cookie: `wfos_session=${cookie}` },
    });
    expect(me2.statusCode).toBe(401);
  });

  it('an invalid session cookie is rejected (expired/unknown → 401)', async () => {
    const me = await server.app.inject({
      method: 'GET', url: '/auth/me',
      headers: { cookie: 'wfos_session=not-a-real-session-token' },
    });
    expect(me.statusCode).toBe(401);
  });

  it('a wrong password is rejected (invalid-credentials, no user enumeration)', async () => {
    await server.app.inject({
      method: 'POST', url: '/auth/signup/email',
      payload: { email: 'http3@example.com', password: 'correct-password-2026' },
    });
    const wrong = await server.app.inject({
      method: 'POST', url: '/auth/login/email',
      payload: { email: 'http3@example.com', password: 'wrong-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect((wrong.json() as { error: string }).error).toBe('invalid-credentials');
    // Unknown email → same response (no enumeration).
    const unknown = await server.app.inject({
      method: 'POST', url: '/auth/login/email',
      payload: { email: 'nobody@example.com', password: 'anything' },
    });
    expect(unknown.statusCode).toBe(401);
    expect((unknown.json() as { error: string }).error).toBe('invalid-credentials');
  });

  it('a human session can access a project the user owns (protected route allowed)', async () => {
    // Signup + create org + membership + project + access.
    const { user } = await stack.emailProvider.signup({
      email: 'http4@example.com', password: 'p@ssw0rd-http4', displayName: 'Http4',
    });
    const org = await stack.organizationRepository.create({ name: 'Http4 Org' });
    await stack.membershipRepository.assign({
      userId: user.id, organizationId: org.id, roleId: 'owner',
    });
    const project = await stack.projectRepository.create({
      organizationId: org.id, name: 'Http4 Project',
    });
    await stack.projectAccessRepository.grant({
      userId: user.id, projectId: project.id, roleId: 'owner',
    });

    // Login via HTTP.
    const login = await server.app.inject({
      method: 'POST', url: '/auth/login/email',
      payload: { email: 'http4@example.com', password: 'p@ssw0rd-http4' },
    });
    const cookie = extractCookie(login.headers['set-cookie'], 'wfos_session');

    // Access the project via the protected /projects/:id route (project.read).
    const res = await server.app.inject({
      method: 'GET', url: `/projects/${project.id}`,
      headers: { cookie: `wfos_session=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a human session CANNOT access another org\'s project (tenant isolation via HTTP)', async () => {
    // User in Org A.
    const { user: userA } = await stack.emailProvider.signup({
      email: 'http5a@example.com', password: 'p@ssw0rd-http5a', displayName: 'Http5A',
    });
    const orgA = await stack.organizationRepository.create({ name: 'Http5 OrgA' });
    await stack.membershipRepository.assign({
      userId: userA.id, organizationId: orgA.id, roleId: 'owner',
    });
    // Project in Org B.
    const orgB = await stack.organizationRepository.create({ name: 'Http5 OrgB' });
    const projectB = await stack.projectRepository.create({
      organizationId: orgB.id, name: 'Http5 ProjectB',
    });

    const login = await server.app.inject({
      method: 'POST', url: '/auth/login/email',
      payload: { email: 'http5a@example.com', password: 'p@ssw0rd-http5a' },
    });
    const cookie = extractCookie(login.headers['set-cookie'], 'wfos_session');

    // User A's session cannot read Org B's project (not-a-member → 403).
    const res = await server.app.inject({
      method: 'GET', url: `/projects/${projectB.id}`,
      headers: { cookie: `wfos_session=${cookie}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { reason: string };
    expect(body.reason).toBe('not-a-member');
  });

  it('an API key (automation) still works alongside sessions on the same routes', async () => {
    const RAW_KEY = 'wfos_test_http_api_key_compat';
    const ENV_VAR = 'WFOS_TEST_HTTP_API_COMPAT';
    process.env[ENV_VAR] = RAW_KEY;
    const org = await stack.organizationRepository.create({ name: 'Http API Org' });
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'http-api-user', displayName: 'Http API User',
    });
    await stack.membershipRepository.assign({
      userId: user.id, organizationId: org.id, roleId: 'owner',
    });
    const project = await stack.projectRepository.create({
      organizationId: org.id, name: 'Http API Project',
    });
    await stack.projectAccessRepository.grant({
      userId: user.id, projectId: project.id, roleId: 'owner',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'http-api-key', secretRef: ENV_VAR,
      externalId: 'http-api-user', label: 'Http API', rawKey: RAW_KEY,
    });

    // GET /projects/:id with the x-api-key header (no session cookie).
    const res = await server.app.inject({
      method: 'GET', url: `/projects/${project.id}`,
      headers: { 'x-api-key': RAW_KEY },
    });
    expect(res.statusCode).toBe(200);
    delete process.env[ENV_VAR];
  });
});

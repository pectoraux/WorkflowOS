import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildRuntimeStack,
  buildRuntimeServer,
  type TestRuntimeStack,
} from '../../helpers/test-identity-runtime-stack.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * WORK-074 — proofs #10 (demo-key removal) + #12 (audit coverage).
 *
 * #10: the Workbench/customer-facing login path no longer accepts or depends
 *      on the demo key. API keys remain first-class (proof #9, separately) —
 *      the demo key is removed from the LOGIN SURFACE, not from the API-key
 *      mechanism.
 * #12: login, logout, credential issuance, and service-account creation are
 *      recorded on the /audit surface (no second audit authority).
 */
describe('WORK-074 — demo-key removal + audit coverage', () => {
  let stack: TestRuntimeStack;
  let server: Awaited<ReturnType<typeof buildRuntimeServer>>;
  let auditEvents: { eventType: string; resourceType: string; resourceId: string; metadata: Record<string, unknown> }[];

  beforeAll(async () => {
    stack = await buildRuntimeStack();
    auditEvents = [];
    // A capturing AuditEventWriter — proves the auth route records events
    // through the existing AuditEventWriter boundary (no second authority).
    const capturingWriter = {
      async write(input: { eventType: string; resourceType: string; resourceId: string; metadata?: Record<string, unknown> }) {
        auditEvents.push({
          eventType: input.eventType,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          metadata: input.metadata ?? {},
        });
        return {} as never;
      },
    };
    server = await buildRuntimeServer(stack, { auditWriter: capturingWriter as never });
  });
  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  // -------------------------------------------------------------------------
  // Proof #10: the demo key is NOT accepted by the customer-facing login path.
  // -------------------------------------------------------------------------
  it('the demo key is NOT accepted by /auth/login/email (not an email/password)', async () => {
    const res = await server.app.inject({
      method: 'POST', url: '/auth/login/email',
      payload: { email: 'wfos-demo-vertex-2026', password: 'wfos-demo-vertex-2026' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('the demo key as a Bearer token on /auth/me does NOT authenticate a session (no session)', async () => {
    // The demo key (if it existed as an API key) would authenticate via the
    // API-key path — but that is the AUTOMATION path, not the customer login.
    // /auth/me with a demo-key Bearer returns the API-key principal (machine/
    // automation), NOT a session. There is no demo key provisioned here, so
    // /auth/me returns 401 (the customer-facing login path does not accept it).
    const res = await server.app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: 'Bearer wfos-demo-vertex-2026' },
    });
    expect(res.statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Proof #10: the production server composition (app.ts) does NOT auto-provision
  // or depend on the demo key. The provision-key.ts script is a dev-only tool.
  // -------------------------------------------------------------------------
  it('provision-key.ts is a dev-only script (not wired into the production server)', () => {
    // Read the backend entrypoint + app.ts; assert they do NOT import provision-key.
    const backendRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const appSrc = readFileSync(`${backendRoot}/src/app.ts`, 'utf8');
    const indexSrc = readFileSync(`${backendRoot}/src/index.ts`, 'utf8');
    expect(appSrc).not.toMatch(/provision-key/);
    expect(indexSrc).not.toMatch(/provision-key/);
    expect(appSrc).not.toMatch(/wfos-demo-vertex-2026/);
    // The provision-key script exists (dev tooling) but is NOT in src/.
    const provisionSrc = readFileSync(`${backendRoot}/provision-key.ts`, 'utf8');
    expect(provisionSrc).toContain('wfos-demo-vertex-2026'); // the dev demo key
  });

  // -------------------------------------------------------------------------
  // Proof #12: login (email) is recorded on the audit surface.
  // -------------------------------------------------------------------------
  it('audit: email signup + login are recorded', async () => {
    const before = auditEvents.length;
    await server.app.inject({
      method: 'POST', url: '/auth/signup/email',
      payload: { email: 'audit1@example.com', password: 'p@ssw0rd-audit1', displayName: 'Audit1' },
    });
    await server.app.inject({
      method: 'POST', url: '/auth/login/email',
      payload: { email: 'audit1@example.com', password: 'p@ssw0rd-audit1' },
    });
    const added = auditEvents.slice(before);
    expect(added.some((e) => e.eventType === 'auth.signup' && e.resourceType === 'user')).toBe(true);
    expect(added.some((e) => e.eventType === 'auth.login' && e.resourceType === 'user')).toBe(true);
    // No raw password appears in audit metadata (credential safety).
    const json = JSON.stringify(added);
    expect(json).not.toContain('p@ssw0rd-audit1');
  });

  // -------------------------------------------------------------------------
  // Proof #12: logout is recorded on the audit surface.
  // -------------------------------------------------------------------------
  it('audit: logout is recorded', async () => {
    const login = await server.app.inject({
      method: 'POST', url: '/auth/login/email',
      payload: { email: 'audit1@example.com', password: 'p@ssw0rd-audit1' },
    });
    const cookie = (login.headers['set-cookie'] as string)?.split(';')[0];
    const before = auditEvents.length;
    await server.app.inject({
      method: 'POST', url: '/auth/logout',
      headers: { cookie },
    });
    const added = auditEvents.slice(before);
    expect(added.some((e) => e.eventType === 'auth.logout')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Proof #12: service-account creation + credential issuance are recorded.
  // -------------------------------------------------------------------------
  it('audit: service-account creation + credential issuance are recorded', async () => {
    // Setup: a human admin in an org.
    const { user } = await stack.emailProvider.signup({
      email: 'audit-admin@example.com', password: 'p@ssw0rd-admin', displayName: 'Admin',
    });
    const org = await stack.organizationRepository.create({ name: 'Audit Org' });
    await stack.membershipRepository.assign({
      userId: user.id, organizationId: org.id, roleId: 'owner',
    });
    const login = await server.app.inject({
      method: 'POST', url: '/auth/login/email',
      payload: { email: 'audit-admin@example.com', password: 'p@ssw0rd-admin' },
    });
    const cookie = (login.headers['set-cookie'] as string)?.split(';')[0];

    const before = auditEvents.length;
    // Create a service account.
    const saRes = await server.app.inject({
      method: 'POST', url: '/auth/service-accounts',
      headers: { cookie },
      payload: { organizationId: org.id, name: 'audit-sa', capabilities: ['workitem.read'] },
    });
    expect(saRes.statusCode).toBe(201);
    const sa = (saRes.json() as { serviceAccount: { id: string } }).serviceAccount;

    // Provision a scoped credential.
    const credRes = await server.app.inject({
      method: 'POST', url: `/auth/service-accounts/${sa.id}/credentials`,
      headers: { cookie },
    });
    expect(credRes.statusCode).toBe(201);

    const added = auditEvents.slice(before);
    expect(added.some((e) => e.eventType === 'service-account.create' && e.resourceType === 'service-account')).toBe(true);
    expect(added.some((e) => e.eventType === 'credential.issue' && e.resourceType === 'api-key-credential')).toBe(true);
    // The raw key is NEVER in audit metadata (credential safety).
    const credJson = JSON.stringify(added);
    const rawKey = (credRes.json() as { rawKey: string }).rawKey;
    expect(credJson).not.toContain(rawKey);
  });
});

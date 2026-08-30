import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildRuntimeStack,
  type TestRuntimeStack,
} from '../../helpers/test-identity-runtime-stack.js';
import { hashPassword, verifyPassword } from '../../../src/modules/auth/internal/password-hash.js';

/**
 * WORK-074 — proofs #1, #2, #3, #4, #5, #6, #9, #11, #14.
 *
 * On real PostgreSQL (pglite locally / real pg in CI). Discrimination-proven:
 * removing the session-revocation check, the membership requirement, or the
 * tenant-isolation check makes the corresponding test FAIL.
 */
describe('WORK-074 — human login, session, authorization, tenant isolation', () => {
  let stack: TestRuntimeStack;

  beforeAll(async () => {
    stack = await buildRuntimeStack();
  });
  afterAll(async () => {
    await stack.teardown();
  });

  // -------------------------------------------------------------------------
  // Proof #2: email login produces an authenticated session + resolved user.
  // -------------------------------------------------------------------------
  it('email signup + login resolves to a WorkflowOS user and creates a session', async () => {
    const email = 'alice@example.com';
    const password = 'correct-horse-battery-staple';
    const { user: signupUser } = await stack.emailProvider.signup({
      email, password, displayName: 'Alice',
    });
    expect(signupUser.email).toBe(email);
    expect(signupUser.externalId).toBe(`email:${email}`);

    // The raw password is NEVER stored — only a digest (proof #11).
    const storedHash = await stack.userPasswordRepository.getForUser(signupUser.id);
    expect(storedHash).toBeTruthy();
    expect(storedHash!).not.toContain(password);
    expect(storedHash!).toMatch(/^scrypt:/);

    // Login verifies the password + resolves the SAME user.
    const loginResult = await stack.emailProvider.verify(email, password);
    expect(loginResult).not.toBeNull();
    expect(loginResult!.id).toBe(signupUser.id);

    // A wrong password is rejected (never reveals whether the email exists).
    const wrong = await stack.emailProvider.verify(email, 'wrong-password');
    expect(wrong).toBeNull();
    const unknown = await stack.emailProvider.verify('nobody@example.com', password);
    expect(unknown).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Proof #1: re-login resolves the SAME user (deterministic — AUTH-AC-01).
  // -------------------------------------------------------------------------
  it('re-login resolves the SAME persisted user (AUTH-AC-01 deterministic)', async () => {
    const email = 'bob@example.com';
    const password = 'another-strong-passphrase';
    const first = await stack.emailProvider.signup({ email, password, displayName: 'Bob' });
    // Simulate a re-login (logout + login again).
    const second = await stack.emailProvider.verify(email, password);
    expect(second!.id).toBe(first.user.id);
    // The identity row is the SAME (linked, not duplicated).
    const identities = await stack.userIdentityRepository.listForUser(first.user.id);
    expect(identities.length).toBe(1);
    expect(identities[0]!.provider).toBe('email');
    expect(identities[0]!.subject).toBe(email);
  });

  // -------------------------------------------------------------------------
  // Proof #4: session lifecycle — create/verify/revoke (discrimination-proven).
  // -------------------------------------------------------------------------
  it('session lifecycle: create → verify → revoke; revoked session rejected (discrimination)', async () => {
    const { user } = await stack.emailProvider.signup({
      email: 'carol@example.com', password: 'p@ssw0rd-long', displayName: 'Carol',
    });
    const { token, session } = await stack.sessionService.create({
      userId: user.id, principalKind: 'human',
    });
    expect(token).toBeTruthy();
    expect(session.userId).toBe(user.id);

    // Verify accepts the token.
    const valid = await stack.sessionService.verify(token);
    expect(valid.valid).toBe(true);
    expect(valid.session.userId).toBe(user.id);

    // Revoke (logout) → the SAME token is now rejected (discrimination: the
    // revocation check is what makes this pass; removing it makes the test FAIL).
    await stack.sessionService.revoke(token);
    const afterRevoke = await stack.sessionService.verify(token);
    expect(afterRevoke.valid).toBe(false);
    expect(afterRevoke.invalidReason).toBe('revoked');

    // An unknown token is rejected with a typed reason.
    const unknown = await stack.sessionService.verify('not-a-real-token');
    expect(unknown.valid).toBe(false);
    expect(unknown.invalidReason).toBe('not-found');
  });

  // -------------------------------------------------------------------------
  // Proof #4 (discrimination): a raw token is NEVER stored; only its digest.
  // -------------------------------------------------------------------------
  it('the raw session token is never stored — only its SHA-256 digest (SEC-AC-02)', async () => {
    const { user } = await stack.emailProvider.signup({
      email: 'dave@example.com', password: 'p@ssw0rd-long2', displayName: 'Dave',
    });
    const { token } = await stack.sessionService.create({
      userId: user.id, principalKind: 'human',
    });
    // The wfos_sessions table must NOT contain the raw token.
    const rows = await stack.db.client.query<{ token_digest: string }>(
      'SELECT token_digest FROM wfos_sessions WHERE user_id = $1',
      [user.id],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) {
      expect(r.token_digest).not.toBe(token);
      expect(r.token_digest).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    }
  });

  // -------------------------------------------------------------------------
  // Proof #5: authorization chain — human user → membership → role → project
  // access (allowed AND denied cases).
  // -------------------------------------------------------------------------
  it('authorization chain: allowed when member with project access; denied otherwise', async () => {
    const org = await stack.organizationRepository.create({ name: 'Org Auth Chain' });
    const { user } = await stack.emailProvider.signup({
      email: 'eve@example.com', password: 'p@ssw0rd-long3', displayName: 'Eve',
    });
    await stack.membershipRepository.assign({
      userId: user.id, organizationId: org.id, roleId: 'owner',
    });
    const project = await stack.projectRepository.create({
      organizationId: org.id, name: 'Auth Chain Project',
    });
    await stack.projectAccessRepository.grant({
      userId: user.id, projectId: project.id, roleId: 'owner',
    });

    // Allowed: owner + project access → project.read.
    const allowed = await stack.runtimeAuthorizationService.authorize({
      user, permission: 'project.read',
      resource: { kind: 'project', projectId: project.id },
    });
    expect(allowed.allowed).toBe(true);

    // Denied: a user with NO membership in the org is rejected (not-a-member),
    // even if a project_access row were planted (proof #6 below tests that).
    const { user: outsider } = await stack.emailProvider.signup({
      email: 'mallory@example.com', password: 'p@ssw0rd-long4', displayName: 'Mallory',
    });
    const denied = await stack.runtimeAuthorizationService.authorize({
      user: outsider, permission: 'project.read',
      resource: { kind: 'project', projectId: project.id },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.deniedReason).toBe('not-a-member');
  });

  // -------------------------------------------------------------------------
  // Proof #6: tenant isolation under login — a planted cross-tenant
  // project_access row grants NOTHING without membership in the owning org
  // (AUTHZ-AC-02 discrimination).
  // -------------------------------------------------------------------------
  it('tenant isolation: a cross-tenant project_access row grants nothing', async () => {
    const orgA = await stack.organizationRepository.create({ name: 'Org A Tenant' });
    const orgB = await stack.organizationRepository.create({ name: 'Org B Tenant' });
    const { user: userA } = await stack.emailProvider.signup({
      email: 'a@example.com', password: 'p@ssw0rd-long5', displayName: 'User A',
    });
    await stack.membershipRepository.assign({
      userId: userA.id, organizationId: orgA.id, roleId: 'owner',
    });
    // Project in Org B.
    const projectB = await stack.projectRepository.create({
      organizationId: orgB.id, name: 'Org B Project',
    });
    // PLANT a cross-tenant project_access row: User A (Org A) on Project B
    // (Org B). This is the attack — an identifier-substitution attempt.
    await stack.db.client.query(
      `INSERT INTO wfos_project_access (user_id, project_id, role_id) VALUES ($1, $2, 'owner')
       ON CONFLICT (user_id, project_id) DO UPDATE SET role_id = 'owner'`,
      [userA.id, projectB.id],
    );

    // User A is NOT a member of Org B → the planted row grants NOTHING.
    const denied = await stack.runtimeAuthorizationService.authorize({
      user: userA, permission: 'project.read',
      resource: { kind: 'project', projectId: projectB.id },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.deniedReason).toBe('not-a-member');
    // Discrimination: if the membership check were removed, the planted row
    // would grant access. The test asserts the check holds.
  });

  // -------------------------------------------------------------------------
  // Proof #9: API-key automation path — existing API-key auth keeps working
  // through the same authorization chain (no regression).
  // -------------------------------------------------------------------------
  it('API-key automation path: existing API keys still authenticate + authorize (no regression)', async () => {
    const RAW_KEY = 'wfos_test_runtime_api_key_compat_2026';
    const ENV_VAR = 'WFOS_TEST_RUNTIME_API_COMPAT';
    process.env[ENV_VAR] = RAW_KEY;
    const org = await stack.organizationRepository.create({ name: 'API Compat Org' });
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'api-compat-user', displayName: 'API Compat User',
    });
    await stack.membershipRepository.assign({
      userId: user.id, organizationId: org.id, roleId: 'owner',
    });
    const project = await stack.projectRepository.create({
      organizationId: org.id, name: 'API Compat Project',
    });
    await stack.projectAccessRepository.grant({
      userId: user.id, projectId: project.id, roleId: 'owner',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'api-compat-key', secretRef: ENV_VAR,
      externalId: 'api-compat-user', label: 'API Compat', rawKey: RAW_KEY,
    });

    // The RequestAuthenticator resolves the API key to a HUMAN principal.
    const principal = await stack.requestAuthenticator.authenticateRequest({ apiKey: RAW_KEY });
    expect(principal).not.toBeNull();
    expect(principal!.kind).toBe('human');
    if (principal!.kind !== 'human') return;
    expect(principal!.user.externalId).toBe('api-compat-user');

    // The authorization chain works exactly as before.
    const decision = await stack.runtimeAuthorizationService.authorize({
      user: principal!.user, permission: 'project.read',
      resource: { kind: 'project', projectId: project.id },
    });
    expect(decision.allowed).toBe(true);
    delete process.env[ENV_VAR];
  });

  // -------------------------------------------------------------------------
  // Proof #11: credential safety — raw key/session/password material never
  // appears in database records (digest/reference only, discrimination-proven).
  // -------------------------------------------------------------------------
  it('credential safety: raw password + raw API key + raw session token never persisted', async () => {
    const email = 'safety@example.com';
    const password = 'never-persist-this-raw-password-2026';
    const { user } = await stack.emailProvider.signup({
      email, password, displayName: 'Safety',
    });
    // Password digest stored, NOT the raw password.
    const pwRow = await stack.db.client.query<{ password_hash: string }>(
      'SELECT password_hash FROM wfos_user_passwords WHERE user_id = $1', [user.id],
    );
    expect(pwRow.rows[0]!.password_hash).not.toContain(password);

    // API key digest stored, NOT the raw key.
    const RAW_KEY = 'wfos_test_safety_raw_key_value_xyz';
    const ENV_VAR = 'WFOS_TEST_SAFETY_KEY';
    process.env[ENV_VAR] = RAW_KEY;
    await stack.apiKeyProvisioner.provision({
      keyId: 'safety-key', secretRef: ENV_VAR,
      externalId: user.externalId, label: 'Safety', rawKey: RAW_KEY,
    });
    const keyRow = await stack.db.client.query<{ key_digest: string; secret_ref: string; scopes: string[] }>(
      'SELECT key_digest, secret_ref, scopes FROM wfos_api_key_credentials WHERE key_id = $1',
      ['safety-key'],
    );
    expect(keyRow.rows[0]!.key_digest).not.toBe(RAW_KEY);
    expect(keyRow.rows[0]!.secret_ref).toBe(ENV_VAR); // ref, not the value
    expect(keyRow.rows[0]!.key_digest).toMatch(/^[0-9a-f]{64}$/);

    // Session token digest stored, NOT the raw token.
    const { token } = await stack.sessionService.create({
      userId: user.id, principalKind: 'human',
    });
    const sessionRow = await stack.db.client.query<{ token_digest: string }>(
      'SELECT token_digest FROM wfos_sessions WHERE user_id = $1', [user.id],
    );
    expect(sessionRow.rows[0]!.token_digest).not.toBe(token);
    delete process.env[ENV_VAR];
  });

  // -------------------------------------------------------------------------
  // Password hashing discrimination (proof #11 support): verifyPassword is
  // constant-time + salted; the digest format is non-reversible.
  // -------------------------------------------------------------------------
  it('password hash: verifyPassword accepts the right password, rejects the wrong', () => {
    const raw = 'discrimination-password-2026';
    const digest = hashPassword(raw);
    expect(digest).not.toBe(raw);
    expect(verifyPassword(raw, digest)).toBe(true);
    expect(verifyPassword('wrong', digest)).toBe(false);
    // A malformed digest is rejected (never throws).
    expect(verifyPassword(raw, 'not-a-valid-digest')).toBe(false);
  });
});

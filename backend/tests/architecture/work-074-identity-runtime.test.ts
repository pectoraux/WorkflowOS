import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WORK-074 — proof #13: static architecture invariants.
 *
 * Asserts the no-second-authority matrix holds with the identity runtime in
 * place, and that the runtime respects the frozen module-boundary discipline.
 */

const BACKEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FRONTEND_ROOT = fileURLToPath(new URL('../../../frontend/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function* walkTs(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkTs(full);
    else if (st.isFile() && (entry.endsWith('.ts') || entry.endsWith('.tsx'))) yield full;
  }
}

function rel(p: string): string {
  return relative(REPO_ROOT, p).split(sep).join('/');
}

describe('WORK-074 — static architecture invariants (no second authority)', () => {
  it('migration 0059 exists with the runtime identity tables', () => {
    const path = join(BACKEND_ROOT, 'src/platform/postgres/migrations/0059_identity_runtime.sql');
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/CREATE TABLE wfos_user_identities/);
    expect(src).toMatch(/CREATE TABLE wfos_user_passwords/);
    expect(src).toMatch(/CREATE TABLE wfos_sessions/);
    expect(src).toMatch(/CREATE TABLE wfos_service_accounts/);
    expect(src).toMatch(/CREATE TABLE wfos_capabilities/);
    expect(src).toMatch(/CREATE TABLE wfos_capability_permissions/);
    // EXTENDS wfos_api_key_credentials (API keys remain first-class — invariant #10).
    expect(src).toMatch(/ALTER TABLE wfos_api_key_credentials\s+ADD COLUMN service_account_id/);
    expect(src).toMatch(/ADD COLUMN scopes/);
  });

  it('migration 0060 creates the OAuth browser-binding pending-flow table', () => {
    const path = join(BACKEND_ROOT, 'src/platform/postgres/migrations/0060_oauth_pending_flows.sql');
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/CREATE TABLE wfos_oauth_pending_flows/);
    // The state is UNIQUE so a callback resolves at most one pending flow.
    expect(src).toMatch(/state\s+TEXT\s+NOT\s+NULL\s+UNIQUE/);
    // The browser_binding is the SHA-256 digest of the httpOnly cookie secret.
    expect(src).toMatch(/browser_binding\s+TEXT\s+NOT\s+NULL/);
    // The flow is one-time-use: consumed_at is NULL until the callback wins.
    expect(src).toMatch(/consumed_at\s+TIMESTAMPTZ/);
    expect(src).toMatch(/expires_at\s+TIMESTAMPTZ\s+NOT\s+NULL/);
  });

  it('the auth route uses the server-side pending-flow store for OAuth (not a state cookie alone)', () => {
    const route = join(BACKEND_ROOT, 'src/api/routes/auth.route.ts');
    const src = readFileSync(route, 'utf8');
    // /auth/login/:provider creates a pending flow + sets the browser-binding cookie.
    expect(src).toMatch(/oauthPendingFlows\.create\(/);
    expect(src).toMatch(/OAUTH_FLOW_COOKIE_NAME/);
    expect(src).toMatch(/browserBindingDigest/);
    // /auth/callback/:provider consumes the flow atomically (replay rejection).
    expect(src).toMatch(/oauthPendingFlows\.consume\(/);
    // The OLD state-cookie approach is gone (no wfos_oauth_state cookie).
    expect(src).not.toMatch(/wfos_oauth_state/);
    expect(src).not.toMatch(/OAUTH_STATE_COOKIE_NAME/);
  });

  it('the runtime identity source files live under src/modules/auth/internal/ (the /auth boundary)', () => {
    const authInternal = join(BACKEND_ROOT, 'src/modules/auth/internal');
    const files = readdirSync(authInternal);
    // The WORK-074 runtime adapters.
    expect(files).toContain('identity-runtime.types.ts');
    expect(files).toContain('pg-session-service.ts');
    expect(files).toContain('pg-service-account-repository.ts');
    expect(files).toContain('pg-user-identity-repository.ts');
    expect(files).toContain('email-auth-provider.ts');
    expect(files).toContain('oauth-provider.ts');
    expect(files).toContain('identity-resolver.ts');
    expect(files).toContain('request-authenticator.ts');
    expect(files).toContain('password-hash.ts');
    expect(files).toContain('pg-oauth-pending-flow-repository.ts');
  });

  it('only src/modules/auth/ declares an AuthorizationService implementation', () => {
    const violations: string[] = [];
    for (const file of walkTs(join(BACKEND_ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8');
      if (/class\s+\w+\s+implements\s+AuthorizationService\b/.test(src) && !file.includes(`${sep}modules${sep}auth${sep}`)) {
        violations.push(rel(file));
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('no second RBAC / project-access / tenant-isolation engine exists outside /auth', () => {
    // The capability → permission mapping is the machine analog of role →
    // permission, BOTH inside /auth. No parallel engine outside /auth.
    const violations: string[] = [];
    const forbidden = /class\s+\w*(Rbac|RbacEngine|ProjectAccessEngine|TenantIsolationEngine|SecondAuthorization)\w*\s*(implements|extends)/;
    for (const file of walkTs(join(BACKEND_ROOT, 'src'))) {
      if (file.includes(`${sep}modules${sep}auth${sep}`)) continue;
      const src = readFileSync(file, 'utf8');
      if (forbidden.test(src)) violations.push(rel(file));
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the auth route imports ONLY from the /auth public boundary (no module internal/ imports)', () => {
    const route = join(BACKEND_ROOT, 'src/api/routes/auth.route.ts');
    const src = readFileSync(route, 'utf8');
    // Imports from @modules/auth (public) — allowed.
    expect(src).toMatch(/from '@modules\/auth\/index.js'/);
    // NO module internal/ imports — the route respects PLAT-AC-02.
    const internalImports = Array.from(src.matchAll(/from\s*'(@modules\/[^']+\/internal\/[^']+|\.\/modules\/[^']+\/internal\/[^']+)'/g)).map((m) => m[1]!);
    expect(internalImports, internalImports.join('\n')).toEqual([]);
  });

  it('the identity runtime introduces NO new module directory (the 17 frozen modules are unchanged)', () => {
    const modulesDir = join(BACKEND_ROOT, 'src/modules');
    const modules = readdirSync(modulesDir).filter((d) => statSync(join(modulesDir, d)).isDirectory());
    // The frozen 17 (per FROZEN_MODULE_NAMES).
    const expected = [
      'agents', 'architecture', 'audit', 'auth', 'github', 'llm', 'notifications',
      'organizations', 'projects', 'requirements', 'reviews', 'runtime',
      'specifications', 'users', 'verification', 'work-items', 'workflows',
    ];
    for (const m of expected) expect(modules).toContain(m);
    // No extra module directory was added.
    expect(modules.length).toBe(expected.length);
  });

  it('frontend LoginPage no longer presents the demo-key API-key input as the primary path', () => {
    const path = join(FRONTEND_ROOT, 'src/pages/LoginPage.tsx');
    const src = readFileSync(path, 'utf8');
    // The primary surface is Google/GitHub/email.
    expect(src).toMatch(/Continue with Google/);
    expect(src).toMatch(/Continue with GitHub/);
    expect(src).toMatch(/signupWithEmail|loginWithEmail/);
    // The API-key input is DEMOTED (behind showApiKey toggle, "automation").
    expect(src).toMatch(/showApiKey/);
    expect(src).toMatch(/automation/i);
    // The default autoFocus is on the EMAIL field, not an API-key field.
    expect(src).not.toMatch(/autoFocus.*api-key|api-key.*autoFocus/);
  });

  it('frontend has no second auth-state authority (one canonical AuthProvider)', () => {
    const frontendSrc = join(FRONTEND_ROOT, 'src');
    let createContextCount = 0;
    let authProviderFiles: string[] = [];
    for (const file of walkTs(frontendSrc)) {
      const src = readFileSync(file, 'utf8');
      if (/createContext<AuthContextValue|createContext\(null\)/.test(src) && /AuthProvider|useAuthContext/.test(src)) {
        createContextCount++;
        authProviderFiles.push(rel(file));
      }
    }
    // Exactly ONE canonical auth-state source.
    expect(createContextCount, authProviderFiles.join('\n')).toBe(1);
  });

  it('frontend never reads provider secrets from process.env (SEC-001)', () => {
    const frontendSrc = join(FRONTEND_ROOT, 'src');
    const SECRET_ENV_RE = /\bprocess\.env\.[A-Z_]*(?:API_KEY|API_TOKEN|SECRET|PASSWORD|PRIVATE_KEY|TOKEN)\b/;
    const violations: string[] = [];
    for (const file of walkTs(frontendSrc)) {
      const src = readFileSync(file, 'utf8');
      // Strip comments (naive — sufficient for a guard).
      const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (SECRET_ENV_RE.test(code)) violations.push(rel(file));
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the new backend source files never log raw credentials (passwords/tokens/secrets)', () => {
    const newFiles = [
      'src/modules/auth/internal/password-hash.ts',
      'src/modules/auth/internal/pg-session-service.ts',
      'src/modules/auth/internal/email-auth-provider.ts',
      'src/modules/auth/internal/oauth-provider.ts',
      'src/modules/auth/internal/request-authenticator.ts',
      'src/modules/auth/internal/identity-resolver.ts',
      'src/api/routes/auth.route.ts',
    ];
    const violations: string[] = [];
    for (const f of newFiles) {
      const src = readFileSync(join(BACKEND_ROOT, f), 'utf8');
      // A console.log/info/error/warn that references a raw password/token/secret variable.
      const logRe = /console\.(log|info|error|warn|debug)\s*\([^)]*(password|rawKey|rawToken|clientSecret|secret|token)/i;
      if (logRe.test(src)) violations.push(f);
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the AuthorizationService interface declares the machine methods (SAME service, no parallel mechanism)', () => {
    const path = join(BACKEND_ROOT, 'src/modules/auth/internal/auth.types.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/authorizeMachine\(/);
    expect(src).toMatch(/authorizeMachineForOrganization\(/);
  });
});

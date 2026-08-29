/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { healthRoutes } from '../../src/api/routes/health.route.js';
import { createS3ObjectStoreFromEnv } from '../../src/platform/storage/s3-object-store.js';

/**
 * DEPLOYMENT HARDENING — production topology invariants.
 *
 * The production topology is: Vercel hosts the Vite SPA (frontend hosting
 * ONLY — no backend logic), proxying /api/* to the Railway backend API; the
 * SAME backend Dockerfile serves the api and worker roles of one modular
 * monolith; PostgreSQL is authoritative; Redis is non-authoritative; object
 * storage stays behind the ObjectStore abstraction.
 *
 * These static/behavioral checks prove the deployment configuration cannot
 * silently violate that topology:
 *
 *   DH-01 — Vercel hosts ONLY the frontend: the deployment configuration is
 *           vercel.ts (no vercel.json), a Vite SPA build with no serverless
 *           functions, no backend business logic, no secrets.
 *   DH-02 — The /api proxy destination is environment-resolved from
 *           API_TARGET (build-time, fail-closed). A hard-coded backend host
 *           is a REJECTING violation — it is what made preview deployments
 *           silently target the production backend.
 *   DH-03 — SPA fallback + static asset serving survive (client-side routing
 *           deep links).
 *   DH-04 — Preview deployments are isolated: the release pipeline's preview
 *           stage targets the non-production canary and PR pipelines never
 *           deploy production Railway state.
 *   DH-05 — One backend image, two roles: the release pipeline deploys the
 *           repository backend to both Railway services; docker-compose
 *           keeps the same-image/different-role contract.
 *   DH-06 — Release sequencing: the release workflow gates the production
 *           frontend deploy on the LIVE backend's deployment identity.
 *   DH-07 — The local docker-compose validation (deploy.yml) remains a
 *           validation-only workflow — it never deploys to cloud providers
 *           and is not a hidden second release system.
 *   DH-08 — The liveness probe carries the non-secret deployment identity
 *           (role/commitSha/environmentName) — the release gate's contract.
 *   DH-09 — The S3 object store fails CLOSED on incomplete configuration
 *           (no silent degradation to filesystem/in-memory in production).
 *   DH-10 — No cloud-provider SDK enters the backend (the S3 adapter is a
 *           dependency-free SigV4 implementation inside the platform layer).
 */

const BACKEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = join(BACKEND_ROOT, '..');
const FE_DIR = join(REPO_ROOT, 'frontend');

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

// ===========================================================================
// DH-01 / DH-02 / DH-03 — Vercel frontend hosting boundary
// ===========================================================================

describe('DEPLOYMENT HARDENING — Vercel frontend hosting boundary', () => {
  it('DH-01: vercel.ts is the single Vercel configuration (no vercel.json)', () => {
    expect(existsSync(join(FE_DIR, 'vercel.ts')), 'frontend/vercel.ts must exist').toBe(true);
    expect(existsSync(join(FE_DIR, 'vercel.json')), 'frontend/vercel.json must NOT exist alongside vercel.ts').toBe(false);
  });

  it('DH-01: the configuration is a Vite SPA build with no serverless functions', () => {
    const src = readFileSync(join(FE_DIR, 'vercel.ts'), 'utf8');
    expect(src).toMatch(/framework:\s*'vite'/);
    expect(src).toMatch(/buildCommand:\s*'bun run build'/);
    expect(src).toMatch(/outputDirectory:\s*'dist'/);
    // No serverless API implementation on Vercel — backend logic stays on
    // Railway. The configuration must not declare functions, builds, or an
    // api/ output directory (a serverless API surface).
    expect(src).not.toMatch(/^\s*functions\s*:/m);
    expect(src).not.toMatch(/^\s*builds\s*:/m);
    expect(src).not.toMatch(/outputDirectory:\s*'api'/);
    // No secrets.
    expect(src).not.toMatch(/(token|secret|password|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}/i);
  });

  it('DH-02: the /api proxy destination resolves from API_TARGET (build-time, fail-closed)', () => {
    const src = readFileSync(join(FE_DIR, 'vercel.ts'), 'utf8');
    // The configuration reads the environment variable…
    expect(src).toMatch(/process\.env\.API_TARGET/);
    // …and FAILS CLOSED when it is not set (the build must fail).
    expect(src).toMatch(/throw new Error\(/);
    expect(src).toMatch(/API_TARGET is not set/);
    // The destination is built from the resolved origin — never a literal host.
    expect(src).toMatch(/`\$\{apiOrigin\}\/\$1`/);
  });

  it('DH-02 (discrimination): a hard-coded backend host in the /api destination is rejected', () => {
    // Import the REAL configuration with a canary target and prove the
    // destination equals the canary — the value comes from the environment.
    // (Subprocess import: the backend test runner must not share module
    // state with the frontend configuration, and a missing API_TARGET must
    // fail closed in a fresh process.)
    const CANARY = 'https://hard-coded-discrimination.invalid';
    const script = `process.env.API_TARGET = ${JSON.stringify(CANARY)};
const { config } = await import(${JSON.stringify(join(FE_DIR, 'vercel.ts'))});
const routes = config.routes ?? [];
const apiRoute = routes.find((r) => r.src === '/api/(.*)');
if (!apiRoute) { console.error('NO_API_ROUTE'); process.exit(1); }
if (apiRoute.dest !== ${JSON.stringify(CANARY)} + '/$1') { console.error('BAD_DEST: ' + apiRoute.dest); process.exit(1); }
if (String(apiRoute.dest).includes('up.railway.app') || String(apiRoute.dest).includes('vercel.app')) { console.error('HARD_CODED_HOST'); process.exit(1); }
const fs = routes.find((r) => r.handle === 'filesystem');
const spa = routes.find((r) => r.src === '/(.*)' && r.dest === '/index.html');
if (!fs || !spa) { console.error('MISSING_ROUTES'); process.exit(1); }
console.log('OK');`;
    let ok = false;
    let stderr = '';
    try {
      const stdout = execFileSync('bun', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      ok = stdout.toString().includes('OK');
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? '').slice(0, 300);
    }
    expect(ok, `discrimination probe failed: ${stderr}`).toBe(true);
  });

  it('DH-02 (fail-closed): a fresh import without API_TARGET exits non-zero', () => {
    // The deployment build must FAIL when the target environment has no
    // API_TARGET — never silently deploy a mis-targeted API proxy.
    const script = `delete process.env.API_TARGET;
try { await import(${JSON.stringify(join(FE_DIR, 'vercel.ts'))}); console.error('NO_THROW'); process.exit(1); }
catch (err) { if (String(err).includes('API_TARGET is not set')) { console.log('OK_FAIL_CLOSED'); process.exit(0); } console.error('WRONG_ERROR: ' + err); process.exit(1); }`;
    let ok = false;
    let stderr = '';
    try {
      const stdout = execFileSync('bun', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      ok = stdout.toString().includes('OK_FAIL_CLOSED');
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? '').slice(0, 300);
    }
    expect(ok, `fail-closed probe failed: ${stderr}`).toBe(true);
  });

  it('DH-03: filesystem serving and the SPA fallback survive', () => {
    // Covered behaviorally by the DH-02 discrimination probe (which asserts
    // the filesystem handle and the SPA fallback routes alongside the API
    // proxy); this static check pins the route declarations in source.
    const src = readFileSync(join(FE_DIR, 'vercel.ts'), 'utf8');
    expect(src).toMatch(/handle:\s*'filesystem'/);
    expect(src).toMatch(/src:\s*'\/\(\.\*\)',\s*dest:\s*'\/index\.html'/);
  });
});

// ===========================================================================
// DH-04 / DH-05 / DH-06 / DH-07 — release pipeline invariants
// ===========================================================================

describe('DEPLOYMENT HARDENING — release pipeline', () => {
  it('DH-04: the release workflow exists and its preview stage is isolated from production', () => {
    const release = read('.github/workflows/release.yml');
    // The preview stage exists…
    expect(release).toMatch(/name: vercel preview \(isolated\)/);
    // …targets the isolation canary by default…
    expect(release).toMatch(/workflowos-preview-canary\.invalid/);
    // …and PROVES isolation after deploying (the preview verification step).
    expect(release).toMatch(/MODE=preview/);
    expect(release).toMatch(/must NOT reach the production backend/);
  });

  it('DH-04 (discrimination): PR pipelines never deploy production state', () => {
    const release = read('.github/workflows/release.yml');
    // The ONLY production deploy command (backslash-continuation form —
    // documentation text in skip messages uses the single-line form and is
    // not a command) appears exactly once…
    const prodCommand = /vercel deploy \.\/frontend \\\n\s*--prod/g;
    const commands = release.match(prodCommand) ?? [];
    expect(commands.length, 'exactly one production deploy command (command form)').toBe(1);
    // …and the job containing it never runs for pull_request events.
    const deployJobStart = release.indexOf('deploy-frontend:');
    const jobSlice = release.slice(deployJobStart, release.indexOf('railway-backend:'));
    expect(jobSlice).toMatch(/if:\s*github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/);
  });

  it('DH-05: one backend image, two roles — the Railway stage deploys the same repository to both services', () => {
    const release = read('.github/workflows/release.yml');
    expect(release).toMatch(/the SAME[\s\S]{0,80}backend\/Dockerfile serves both roles/);
    expect(release).toMatch(/WORKFLOWOS_ROLE=api/);
    expect(release).toMatch(/WORKFLOWOS_ROLE=worker/);
    // docker-compose keeps the same-image/different-role contract.
    const compose = read('docker-compose.yml');
    expect(compose).toMatch(/WORKFLOWOS_ROLE: api/);
    expect(compose).toMatch(/WORKFLOWOS_ROLE: worker/);
    expect((compose.match(/dockerfile: Dockerfile/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('DH-06: production frontend deploys are gated on the live backend contract (release sequencing)', () => {
    const release = read('.github/workflows/release.yml');
    expect(release).toMatch(/backend-contract-gate/);
    // The gate probes the LIVE backend's deployment identity…
    expect(release).toMatch(/deployment\.commitSha/);
    // …requires ancestry…
    expect(release).toMatch(/git merge-base --is-ancestor/);
    // …and the frontend deploy depends on the gate.
    const deployJobStart = release.indexOf('deploy-frontend:');
    const needsSlice = release.slice(deployJobStart, deployJobStart + 600);
    expect(needsSlice).toMatch(/needs:.*backend-contract-gate/);
    // The architect-controlled exceptional escape hatch exists and is recorded.
    expect(release).toMatch(/skip_backend_gate/);
  });

  it('DH-07: the docker-compose workflow (deploy.yml) never deploys to cloud providers', () => {
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).toMatch(/does NOT deploy to any cloud provider/);
    // No cloud CLI invocations in the local validation workflow.
    expect(deploy).not.toMatch(/\bvercel deploy\b/);
    expect(deploy).not.toMatch(/\brailway up\b/);
  });

  it('DH-04/DH-07 (discrimination): the release workflow skips visibly when credentials are absent', () => {
    const release = read('.github/workflows/release.yml');
    // Credential presence probe produces booleans only…
    expect(release).toMatch(/has_vercel/);
    expect(release).toMatch(/has_railway/);
    // …and absent credentials produce an EXPLICIT skip warning, never a silent success.
    expect(release).toMatch(/explicit skip, not a success claim/);
  });
});

// ===========================================================================
// DH-08 — liveness deployment identity (behavioral)
// ===========================================================================

describe('DEPLOYMENT HARDENING — health deployment identity', () => {
  async function appWith(
    deps: Parameters<typeof healthRoutes>[1],
  ): Promise<ReturnType<typeof Fastify>> {
    const app = Fastify();
    await healthRoutes(app, deps);
    return app;
  }

  it('DH-08: liveness reports the non-secret deployment identity when wired', async () => {
    const app = await appWith({
      deployment: { role: 'api', commitSha: 'a12444a', environmentName: 'production' },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      deployment: { role: 'api', commitSha: 'a12444a', environmentName: 'production' },
    });
    await app.close();
  });

  it('DH-08: optional identity fields are omitted when the platform does not provide them', async () => {
    const app = await appWith({ deployment: { role: 'worker' } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok', deployment: { role: 'worker' } });
    await app.close();
  });

  it('DH-08 (backward compatibility): liveness without deployment wiring keeps the legacy shape', async () => {
    const app = await appWith({});
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('DH-08: the process entrypoint wires Railway deployment identity into the health deps', () => {
    const src = readFileSync(join(BACKEND_ROOT, 'src', 'index.ts'), 'utf8');
    expect(src).toMatch(/RAILWAY_GIT_COMMIT_SHA/);
    expect(src).toMatch(/RAILWAY_ENVIRONMENT_NAME/);
    expect(src).toMatch(/deployment:\s*\{/);
  });

  it('DH-08: the deployment identity carries no secret material', async () => {
    // The wired identity has exactly three fields: role, commitSha?,
    // environmentName?. A public commit SHA and environment name are not
    // secrets; the test pins the field set so a future field addition must
    // consciously justify itself against the no-secrets rule.
    const app = await appWith({
      deployment: { role: 'api', commitSha: 'deadbeef', environmentName: 'production' },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    const deployment = res.json().deployment as Record<string, unknown>;
    expect(Object.keys(deployment).sort()).toEqual(['commitSha', 'environmentName', 'role']);
    await app.close();
  });
});

// ===========================================================================
// DH-09 — S3 object store fails closed on incomplete configuration
// ===========================================================================

describe('DEPLOYMENT HARDENING — object storage configuration', () => {
  const REQUIRED = [
    'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_ENDPOINT',
    'OBJECT_STORAGE_ACCESS_KEY_ID',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  ] as const;

  function withEnv(values: Partial<Record<string, string | undefined>>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const k of [...REQUIRED, 'OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_REGION']) {
      saved[k] = process.env[k];
    }
    for (const k of Object.keys(saved)) delete process.env[k];
    for (const [k, v] of Object.entries(values)) {
      if (v !== undefined) process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('DH-09: provider != s3 returns undefined (other adapters handle storage)', () => {
    withEnv({ OBJECT_STORAGE_PROVIDER: 'fs' }, () => {
      expect(createS3ObjectStoreFromEnv()).toBeUndefined();
    });
  });

  it('DH-09: complete S3 configuration constructs the adapter and describes it without secrets', () => {
    withEnv(
      {
        OBJECT_STORAGE_PROVIDER: 's3',
        OBJECT_STORAGE_BUCKET: 'workflowos-prod',
        OBJECT_STORAGE_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
        OBJECT_STORAGE_REGION: 'auto',
        OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
        OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
      },
      () => {
        const store = createS3ObjectStoreFromEnv();
        expect(store).toBeDefined();
        const described = store!.describe();
        // The non-secret summary names the provider/bucket/endpoint-host/region…
        expect(described).toEqual({
          provider: 's3',
          bucket: 'workflowos-prod',
          endpointHost: 'accountid.r2.cloudflarestorage.com',
          region: 'auto',
        });
        // …and NEVER includes credentials.
        expect(JSON.stringify(described)).not.toContain('test-access-key');
        expect(JSON.stringify(described)).not.toContain('test-secret-key');
      },
    );
  });

  it('DH-09 (discrimination): incomplete S3 configuration THROWS instead of silently degrading', () => {
    // Complete provider selection but EVERY required variable missing —
    // the previous behavior returned undefined, which silently degraded
    // production object storage to the filesystem/in-memory adapter.
    withEnv({ OBJECT_STORAGE_PROVIDER: 's3' }, () => {
      expect(() => createS3ObjectStoreFromEnv()).toThrow(/OBJECT_STORAGE_PROVIDER=s3/);
    });
    // Partial configuration (the realistic typo case) also throws.
    for (const missing of REQUIRED) {
      const values: Record<string, string> = {
        OBJECT_STORAGE_PROVIDER: 's3',
        OBJECT_STORAGE_BUCKET: 'workflowos-prod',
        OBJECT_STORAGE_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
        OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
        OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
      };
      delete values[missing];
      withEnv(values, () => {
        expect(() => createS3ObjectStoreFromEnv(), `missing ${missing} must throw`).toThrow(
          new RegExp(missing),
        );
      });
    }
  });

  it('DH-09: the app composition logs the ACTIVE object store (non-secret observability)', () => {
    const src = readFileSync(join(BACKEND_ROOT, 'src', 'app.ts'), 'utf8');
    expect(src).toMatch(/app\.object_store\.active/);
    expect(src).toMatch(/\.describe\(\)/);
  });
});

// ===========================================================================
// DH-10 — no cloud-provider SDK in the backend
// ===========================================================================

describe('DEPLOYMENT HARDENING — provider boundaries', () => {
  it('DH-10: no cloud-provider SDK dependency is introduced (dependency-free SigV4 adapter)', () => {
    const pkg = JSON.parse(readFileSync(join(BACKEND_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const cloudSDKs = Object.keys(all).filter((dep) =>
      /@aws-sdk|aws-sdk|@vercel\/node|@railway|@google-cloud|@azure/i.test(dep),
    );
    expect(cloudSDKs, `cloud-provider SDKs must not be dependencies: ${cloudSDKs.join(', ')}`).toEqual([]);
    // The S3 adapter implements SigV4 itself (no SDK import).
    const s3 = readFileSync(join(BACKEND_ROOT, 'src', 'platform', 'storage', 's3-object-store.ts'), 'utf8');
    expect(s3).not.toMatch(/@aws-sdk|aws-sdk/);
    expect(s3).toMatch(/AWS4-HMAC-SHA256/);
  });

  it('DH-10: the verification scripts exist and discriminate production from preview modes', () => {
    const verify = read('scripts/verify-cloud-deployment.sh');
    // Both modes exist in the verification contract…
    expect(verify).toMatch(/MODE=production/);
    expect(verify).toMatch(/MODE=preview/);
    // …preview mode REJECTS a deployment that reaches a live backend
    // (isolation is a failing condition, not a warning)…
    expect(verify).toMatch(/isolation violated/);
    expect(verify).toMatch(/must NOT reach production state/);
    // …and production mode REQUIRES the rewrite to reach the backend.
    expect(verify).toMatch(/did not reach a healthy backend/);
  });
});

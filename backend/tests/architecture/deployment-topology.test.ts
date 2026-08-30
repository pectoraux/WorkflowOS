/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
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
 *
 * REQUEST CHANGES remediation (2026-08-29 architect verdict) — the release
 * DAG is additionally enforced as machine-checked structure:
 *   RD-01 — The production release is a STRICT PIPELINE (gate → api deploy →
 *           worker deploy → live verification → frontend deploy → evidence);
 *           the pre-remediation CONCURRENT shape (frontend + backend stages
 *           running in parallel after the gate) is a REJECTING violation.
 *   RD-02 — Normal production releases FAIL CLOSED when Railway credentials
 *           are absent (a visible-skip step is a REJECTING violation on the
 *           production path).
 *   RD-03 — The frontend deploy fails closed without VERCEL_TOKEN.
 *   RD-04 — No production stage runs for pull_request events.
 *   RD-05 — The live backend verification proves identity (commitSha ==
 *           release SHA) AND full readiness (200, object store included).
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
    const jobSlice = release.slice(deployJobStart, release.indexOf('deployment-evidence:'));
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
    // …and the frontend deploy depends on the LIVE-VERIFIED backend stage
    // (backend-verification), not merely on the ancestry precheck.
    const deployJobStart = release.indexOf('deploy-frontend:');
    const needsSlice = release.slice(deployJobStart, deployJobStart + 600);
    expect(needsSlice).toMatch(/needs:.*backend-verification/);
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

  it('DH-04/DH-07 (discrimination): absent credentials are visible skips ONLY on the PR preview path', () => {
    const release = read('.github/workflows/release.yml');
    // Credential presence probe produces booleans only…
    expect(release).toMatch(/has_vercel/);
    expect(release).toMatch(/has_railway/);
    // …and the PREVIEW stage (the only optional stage — a per-PR convenience
    // that never touches production) skips VISIBLY when VERCEL_TOKEN is
    // absent, never a silent success…
    expect(release).toMatch(/explicit skip, not a success claim/);
    // …while EVERY production-path stage fails CLOSED on absent credentials
    // (enforced structurally by the RD-02/RD-03 checks below): split the
    // workflow at the production job headers and inspect each job BODY —
    // none of them may contain a skip-instead-of-fail warning step.
    const parts = release.split(/\n  (railway-api-deploy|railway-worker-deploy|deploy-frontend):/);
    for (let i = 1; i < parts.length; i += 2) {
      const jobName = parts[i];
      const body = parts[i + 1] ?? '';
      if (/::warning::[^\n]*SKIPPED/.test(body)) {
        throw new Error(
          `production-path job ${jobName} still contains a skip-instead-of-fail step:\n${body.slice(0, 200)}`,
        );
      }
    }
  });
});

// ===========================================================================
// RD-* — release DAG enforcement (REQUEST CHANGES remediation, 2026-08-29)
//
// The architect verdict found the release DAG was NOT actually sequential:
// deploy-frontend and the Railway stage both depended only on the
// backend-contract gate (a real deployment race), and a normal production
// release could proceed with Railway credentials absent (unsafe skip). These
// checks parse the workflow STRUCTURE (not prose) and discriminate both
// historical failure modes — the pre-remediation shapes are REJECTING
// violations.
// ===========================================================================

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
}
interface WorkflowJob {
  name?: string;
  needs?: string[];
  if?: string;
  steps?: WorkflowStep[];
  outputs?: Record<string, string>;
}
interface ReleaseWorkflow {
  jobs: Record<string, WorkflowJob>;
}

function loadReleaseWorkflow(): ReleaseWorkflow {
  return parseYaml(read('.github/workflows/release.yml')) as ReleaseWorkflow;
}

/** The required strict pipeline: stage → the job that must precede it. */
const STRICT_PIPELINE: Array<[string, string]> = [
  ['railway-api-deploy', 'backend-contract-gate'],
  ['railway-worker-deploy', 'railway-api-deploy'],
  ['backend-verification', 'railway-worker-deploy'],
  ['deploy-frontend', 'backend-verification'],
  ['deployment-evidence', 'deploy-frontend'],
];

/**
 * A stage is properly sequenced when its `needs` includes its required
 * predecessor (so it can never start before the predecessor finished) AND
 * it does not run for pull_request events (production-path only).
 */
function pipelineViolations(
  jobs: Record<string, WorkflowJob>,
): string[] {
  const violations: string[] = [];
  for (const [stage, predecessor] of STRICT_PIPELINE) {
    const job = jobs[stage];
    if (!job) {
      violations.push(`missing job: ${stage}`);
      continue;
    }
    const needs = job.needs ?? [];
    if (!needs.includes(predecessor)) {
      violations.push(
        `${stage} must need ${predecessor} (got: [${needs.join(', ')}]) — production stages must never run concurrently`,
      );
    }
    if (/pull_request/.test(job.if ?? '')) {
      violations.push(`${stage} must never run for pull_request events`);
    }
  }
  return violations;
}

/**
 * A fail-closed credential guard: the step that runs when the credential is
 * ABSENT must exit non-zero with an ::error:: — a warning-only "visible
 * skip" lets a production release proceed without the deploy it depends on.
 */
function isFailClosed(step: WorkflowStep | undefined): boolean {
  if (!step) return false;
  const run = step.run ?? '';
  return /::error::/.test(run) && /\bexit 1\b/.test(run) && !/::warning::.*SKIPPED/.test(run);
}

function stepFor(jobs: Record<string, WorkflowJob>, job: string, condPrefix: string): WorkflowStep | undefined {
  return (jobs[job]?.steps ?? []).find((s) => (s.if ?? '').startsWith(condPrefix));
}

describe('DEPLOYMENT HARDENING — release DAG enforcement (REQUEST CHANGES remediation)', () => {
  it('RD-01: the production release is a STRICT pipeline (no concurrent production stages)', () => {
    const jobs = loadReleaseWorkflow().jobs;
    const violations = pipelineViolations(jobs);
    expect(violations, violations.join('; ')).toEqual([]);
  });

  it('RD-01 (discrimination): the pre-remediation CONCURRENT topology is rejected', () => {
    // Reconstruct the architect's finding: both deploy-frontend and a single
    // railway-backend job hanging directly off the gate (parallel branches).
    const oldShape: Record<string, WorkflowJob> = {
      'backend-contract-gate': {},
      'railway-backend': { needs: ['backend-contract-gate'] },
      'deploy-frontend': { needs: ['backend-contract-gate', 'credentials'] },
    };
    const violations = pipelineViolations(oldShape);
    expect(violations.length, 'the concurrent shape MUST be rejected').toBeGreaterThan(0);
    expect(violations.join('; ')).toMatch(/railway-api-deploy/);
    expect(violations.join('; ')).toMatch(/deploy-frontend must need backend-verification/);
  });

  it('RD-02: normal production releases FAIL CLOSED without Railway credentials', () => {
    const jobs = loadReleaseWorkflow().jobs;
    for (const job of ['railway-api-deploy', 'railway-worker-deploy']) {
      const guard = stepFor(jobs, job, 'needs.credentials.outputs.has_railway !=');
      expect(guard, `${job} must have a has_railway guard step`).toBeDefined();
      expect(
        isFailClosed(guard),
        `${job}'s absent-credential step must exit 1 with ::error:: (fail-closed), not skip`,
      ).toBe(true);
    }
  });

  it('RD-02 (discrimination): a visible-skip step is REJECTED on the production path', () => {
    // The pre-remediation shape: warning + success when Railway credentials
    // were absent — a normal release could then ship the frontend against an
    // undeployed backend.
    const skipStep: WorkflowStep = {
      name: 'No Railway token configured — backend deploy SKIPPED (visible)',
      if: "needs.credentials.outputs.has_railway != 'true'",
      run: 'echo "::warning::RAILWAY_TOKEN secret is not configured — automated Railway backend deployment SKIPPED. This is an explicit skip, not a success claim."',
    };
    expect(isFailClosed(skipStep), 'a warning-only skip must NOT count as fail-closed').toBe(false);
  });

  it('RD-03: the frontend deploy fails closed without VERCEL_TOKEN', () => {
    const jobs = loadReleaseWorkflow().jobs;
    const guard = stepFor(jobs, 'deploy-frontend', 'needs.credentials.outputs.has_vercel !=');
    expect(guard, 'deploy-frontend must have a has_vercel guard step').toBeDefined();
    expect(isFailClosed(guard), 'the absent-VERCEL_TOKEN step must exit 1 with ::error::').toBe(true);
  });

  it('RD-04: no production stage runs for pull_request events', () => {
    const jobs = loadReleaseWorkflow().jobs;
    for (const job of STRICT_PIPELINE.map(([s]) => s)) {
      expect(
        jobs[job]?.if ?? '',
        `${job} must be gated on push/workflow_dispatch only`,
      ).toMatch(/github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/);
    }
  });

  it("RD-05: backend-verification proves identity AND full readiness (including the object store)", () => {
    const jobs = loadReleaseWorkflow().jobs;
    const verify = (jobs['backend-verification']?.steps ?? []).find((s) => (s.run ?? '').includes('/health'));
    expect(verify, 'backend-verification must probe the live backend').toBeDefined();
    const run = verify?.run ?? '';
    // Identity: the live /health must report the release SHA…
    expect(run).toMatch(/deployment\.commitSha/);
    expect(run).toMatch(/RELEASE_SHA/);
    expect(run).toMatch(/\$BACKEND_SHA" != "\$RELEASE_SHA"/);
    // …and readiness must be REQUIRED (200 + every dependency check ok),
    // not merely recorded.
    expect(run).toMatch(/health\/ready/);
    expect(run).toMatch(/READY_CODE" = "200"/);
    expect(run).toMatch(/RELEASE BLOCKED/i);
  });
});

// ===========================================================================
// RD-06 / RD-07 / RD-08 — deployment identity records + release recovery
// (REQUEST CHANGES remediation round 2, 2026-08-29)
//
// The architect verdict found the deployment evidence was NOT authoritative:
// the backend was recorded as "see railway-backend job…" (job-log prose)
// instead of actual provider deployment identities, and no durable
// cross-provider provenance tied release commit ↔ Vercel ↔ Railway api ↔
// Railway worker. These checks parse the workflow STRUCTURE and the process
// entrypoint, and discriminate the pre-remediation shapes.
// ===========================================================================

/** The evidence job must directly need every stage whose outputs it records. */
const EVIDENCE_REQUIRED_NEEDS = [
  'railway-api-deploy',
  'railway-worker-deploy',
  'backend-verification',
  'deploy-frontend',
] as const;

function jobRun(jobs: Record<string, WorkflowJob>, job: string): string {
  return (jobs[job]?.steps ?? []).map((s) => s.run ?? '').join('\n');
}

function evidenceIdentityViolations(jobs: Record<string, WorkflowJob>): string[] {
  const violations: string[] = [];
  const evidence = jobs['deployment-evidence'];
  if (!evidence) return ['missing job: deployment-evidence'];
  const needs = evidence.needs ?? [];
  for (const stage of EVIDENCE_REQUIRED_NEEDS) {
    if (!needs.includes(stage)) {
      violations.push(
        `deployment-evidence must need ${stage} DIRECTLY (job outputs are only readable through a direct need — and an interrupted ${stage} must skip the evidence entirely)`,
      );
    }
  }
  const run = jobRun(jobs, 'deployment-evidence');
  // The record must carry the actual provider identities + observed SHAs…
  for (const field of ['releaseCommit', 'deploymentId', 'imageDigest', 'observedSha', 'schemaVersion']) {
    if (!run.includes(field)) {
      violations.push(`the evidence JSON must record ${field} (machine-readable identity, not prose)`);
    }
  }
  // …never a prose pointer at a job log (the pre-remediation shape).
  if (/automatedDeploy|see .*job|see .*log/i.test(run)) {
    violations.push(
      'the evidence must record ACTUAL deployment identities — "see <job>…" prose pointers are a rejecting violation',
    );
  }
  // The record must be VALIDATED: an incomplete/uncoordinated identity
  // FAILS the evidence job instead of attesting the release.
  if (!/sys\.exit\(1\)/.test(run) || !/::error::/.test(run)) {
    violations.push('the evidence job must FAIL (exit 1 + ::error::) when the identity record is incomplete or uncoordinated');
  }
  if (!/observedSha[^=]*!=|!= .*releaseCommit/.test(run)) {
    violations.push('the evidence job must verify every observedSha equals the releaseCommit (cross-provider coordination)');
  }
  return violations;
}

function identityCaptureViolations(jobs: Record<string, WorkflowJob>): string[] {
  const violations: string[] = [];
  for (const job of ['railway-api-deploy', 'railway-worker-deploy'] as const) {
    const j = jobs[job];
    if (!j) {
      violations.push(`missing job: ${job}`);
      continue;
    }
    const run = jobRun(jobs, job);
    if (!run.includes('railway deployment list')) {
      violations.push(`${job} must read Railway's OWN deployment record (railway deployment list --json) — the deployment identity is Railway's, not the pipeline's`);
    }
    if (!/"SUCCESS"|'SUCCESS'/.test(run)) {
      violations.push(`${job} must poll until the release's deployment is SUCCESS before recording its identity`);
    }
    if (!run.includes('pre-deployment-ids')) {
      violations.push(`${job} must identify the new deployment by set-difference from the pre-deploy snapshot (no clock assumptions)`);
    }
    if (!Object.keys(j.outputs ?? {}).includes('deployment_id')) {
      violations.push(`${job} must emit a deployment_id output for the evidence record`);
    }
  }
  // Worker-specific: the live revision observed from the boot log (the
  // worker serves no HTTP by design).
  const worker = jobs['railway-worker-deploy'];
  if (worker) {
    const run = jobRun(jobs, 'railway-worker-deploy');
    if (!run.includes('app.process.starting')) {
      violations.push('the worker stage must observe the live boot identity (app.process.starting commitSha) from the deployed worker logs');
    }
    if (!Object.keys(worker.outputs ?? {}).includes('observed_sha')) {
      violations.push('the worker stage must emit an observed_sha output (what the RUNNING process attests, not the configured variable)');
    }
  }
  // Cross-role revision coordination at the enforcement point.
  const verifyRun = jobRun(jobs, 'backend-verification');
  if (!/WORKER_OBSERVED_SHA.*!=.*RELEASE_SHA/s.test(verifyRun)) {
    violations.push('backend-verification must enforce api/worker revision coordination (worker observed boot SHA == release SHA)');
  }
  return violations;
}

function bootIdentityViolations(entrySource: string): string[] {
  const violations: string[] = [];
  const mainStart = entrySource.indexOf('async function main');
  const roleBranch = entrySource.indexOf("config.role === 'api'");
  const bootLog = entrySource.indexOf('app.process.starting');
  if (mainStart < 0 || roleBranch < 0) return ['entrypoint shape unrecognized (main/role-branch not found)'];
  if (bootLog < 0) {
    violations.push('the entrypoint must log a boot identity line (app.process.starting)');
  } else if (bootLog < mainStart || bootLog > roleBranch) {
    violations.push('the boot identity log must run in main() BEFORE the role branch — the worker role must log it too (it serves no HTTP)');
  }
  const bootSection = entrySource.slice(Math.max(0, bootLog - 900), bootLog + 300);
  if (!bootSection.includes('RAILWAY_GIT_COMMIT_SHA') || !bootSection.includes('WORKFLOWOS_COMMIT_SHA')) {
    violations.push('the boot identity must derive commitSha from RAILWAY_GIT_COMMIT_SHA ?? WORKFLOWOS_COMMIT_SHA');
  }
  if (!/commitSha/.test(bootSection)) {
    violations.push('the boot identity log must include the commitSha field');
  }
  return violations;
}

describe('DEPLOYMENT HARDENING — deployment identity records (REQUEST CHANGES remediation round 2)', () => {
  it('RD-06: deployment-evidence records the machine-readable cross-provider identity and validates it', () => {
    const jobs = loadReleaseWorkflow().jobs;
    const violations = evidenceIdentityViolations(jobs);
    expect(violations, violations.join('; ')).toEqual([]);
  });

  it('RD-06 (discrimination): the pre-remediation prose-pointer evidence shape is rejected', () => {
    // The architect's finding: the backend was recorded as
    // "automatedDeploy": "see railway-backend job…" and the job needed only
    // deploy-frontend — no provider identity, no observed SHAs, and an
    // interrupted Railway stage could not have stopped the record.
    const oldShape: Record<string, WorkflowJob> = {
      'railway-api-deploy': {},
      'railway-worker-deploy': {},
      'backend-verification': {},
      'deploy-frontend': {},
      'deployment-evidence': {
        needs: ['deploy-frontend'],
        steps: [
          {
            run: 'cat > evidence/deployment-evidence.json <<EOF\n' +
              '{"backend": {"automatedDeploy": "see railway-backend job (visible skip when RAILWAY_TOKEN absent)"},\n' +
              ' "verification": "see deploy-frontend job (live production verification)"}\n' +
              'EOF',
          },
        ],
      },
    };
    const violations = evidenceIdentityViolations(oldShape);
    expect(violations.length, 'the prose-pointer shape MUST be rejected').toBeGreaterThan(0);
    expect(violations.join('; ')).toMatch(/need railway-api-deploy DIRECTLY/);
    expect(violations.join('; ')).toMatch(/automatedDeploy|see .*job/);
    expect(violations.join('; ')).toMatch(/must FAIL \(exit 1/);
  });

  it('RD-07: the deploy stages capture authoritative Railway deployment identities (and the worker OBSERVED SHA)', () => {
    const jobs = loadReleaseWorkflow().jobs;
    const violations = identityCaptureViolations(jobs);
    expect(violations, violations.join('; ')).toEqual([]);
  });

  it('RD-07 (discrimination): a deploy stage without identity capture is rejected', () => {
    // The pre-remediation stage: `railway up` alone, deployment identity
    // left to job-log prose.
    const oldShape: Record<string, WorkflowJob> = {
      'railway-api-deploy': {
        steps: [{ run: 'railway up --ci --service "WorkflowOS"' }],
      },
      'railway-worker-deploy': {
        steps: [{ run: 'railway up --ci --service "WorkflowOS-Worker"' }],
      },
      'backend-verification': { steps: [{ run: 'curl /health' }] },
    };
    const violations = identityCaptureViolations(oldShape);
    expect(violations.length, 'the identity-less deploy shape MUST be rejected').toBeGreaterThan(0);
    expect(violations.join('; ')).toMatch(/railway deployment list/);
    expect(violations.join('; ')).toMatch(/deployment_id output/);
    expect(violations.join('; ')).toMatch(/app\.process\.starting/);
    expect(violations.join('; ')).toMatch(/observed_sha output/);
    expect(violations.join('; ')).toMatch(/revision coordination/);
  });

  it('RD-08: the release recovery protocol is documented and structurally enforced', () => {
    // (a) the workflow documents the four failure modes…
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toMatch(/RELEASE RECOVERY PROTOCOL/);
    for (const mode of [/API deploy fails/, /canceled mid-release/, /Restart mid-release/, /different revisions/]) {
      expect(workflow, `the recovery protocol must cover: ${mode}`).toMatch(mode);
    }
    // (b) …and the operator doc carries the same protocol…
    const production = read('docs/deployment/production.md');
    expect(production).toMatch(/Release recovery protocol/i);
    expect(production).toMatch(/interrupted releases & mixed revisions|interrupted releases and mixed revisions/i);
    // (c) …while the STRUCTURAL enforcement holds: the evidence job needs
    // every stage directly, so a failed/canceled stage (an interrupted
    // release) can never produce a partial identity record.
    const jobs = loadReleaseWorkflow().jobs;
    const needs = jobs['deployment-evidence']?.needs ?? [];
    for (const stage of EVIDENCE_REQUIRED_NEEDS) {
      expect(needs, `an interrupted ${stage} must skip deployment-evidence entirely`).toContain(stage);
    }
    // (d) the object-storage durability contract is explicit (MinIO +
    // volume = the persistence authority), with the restart drill.
    expect(production).toMatch(/Durability contract/);
    expect(production).toMatch(/persistence drill|persistence\/restart drill/i);
    expect(production).toMatch(/railway redeploy --service MinIO/);
  });

  it('DH-11: the process entrypoint logs the boot deployment identity for ALL roles (the worker has no HTTP surface)', () => {
    const src = read('backend/src/index.ts');
    const violations = bootIdentityViolations(src);
    expect(violations, violations.join('; ')).toEqual([]);
  });

  it('DH-11 (discrimination): a boot identity log placed INSIDE the api branch (worker-blind) is rejected', () => {
    // The worker serves no HTTP — an identity log emitted only on the api
    // path leaves the worker's live revision unobservable.
    const workerBlind = [
      'async function main(): Promise<void> {',
      '  const config = loadConfig();',
      '  const app = await buildApp(config, { startWorker: config.role !== "api" });',
      "  if (config.role === 'api' || config.role === 'all') {",
      '    app.deps.logger.info("app.process.starting", { commitSha: process.env.WORKFLOWOS_COMMIT_SHA });',
      '  }',
      '}',
    ].join('\n');
    const violations = bootIdentityViolations(workerBlind);
    expect(violations.length, 'the worker-blind placement MUST be rejected').toBeGreaterThan(0);
    expect(violations.join('; ')).toMatch(/BEFORE the role branch/);
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

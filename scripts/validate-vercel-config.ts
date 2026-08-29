/**
 * Validate the WorkflowOS frontend Vercel deployment configuration.
 *
 * DEPLOYMENT HARDENING — this script is the configuration gate for the
 * frontend hosting boundary. It runs in CI (release workflow, PR + main) and
 * can be run locally:
 *
 *   bun scripts/validate-vercel-config.ts        (from the repository root)
 *
 * Validates the structural invariants of `frontend/vercel.ts`:
 *
 *   VC-01 — exactly ONE Vercel configuration file exists (vercel.ts);
 *           a co-existing vercel.json would silently take precedence or
 *           conflict, and was the carrier of the hard-coded production URL.
 *   VC-02 — the project is a Vite SPA deployment (framework/install/build/
 *           output) with no server-side runtime of its own.
 *   VC-03 — `/api/(.*)` is proxied to the environment-resolved API origin
 *           (from API_TARGET, stripped of the /api prefix). The validation
 *           imports the configuration with a canary API_TARGET and asserts
 *           the compiled destination equals the canary — proving the
 *           destination comes from the environment, not from a hard-coded
 *           host. A literal production host in the destination is a
 *           REJECTING violation: it would make every preview deployment
 *           silently target the production backend — the exact
 *           preview-mutates-production hazard this configuration prevents.
 *   VC-04 — static assets are served from the build output (filesystem
 *           handling) and every other path falls back to `/index.html`
 *           (client-side routing deep links).
 *   VC-05 — the configuration contains no credential-looking literals
 *           (tokens/keys/passwords) — Vercel is frontend hosting only.
 *   VC-06 — FAIL-CLOSED: importing the configuration WITHOUT API_TARGET
 *           must throw (the build must fail rather than deploy a frontend
 *           whose API proxy silently points somewhere else).
 *
 * Exits 0 when all invariants hold, 1 with a precise message otherwise.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CANARY = 'https://validation-canary.invalid';

// Import the configuration with the canary API_TARGET — the compiled
// destination must be derived from it.
process.env.API_TARGET = CANARY;
const { config } = await import('../frontend/vercel.ts');

const failures: string[] = [];
const notes: string[] = [];

function check(id: string, ok: boolean, message: string): void {
  if (ok) {
    notes.push(`${id} OK — ${message}`);
  } else {
    failures.push(`${id} FAILED — ${message}`);
  }
}

// --- VC-01: exactly one configuration file ---------------------------------
const vercelJsonExists = existsSync(new URL('../frontend/vercel.json', import.meta.url));
check(
  'VC-01',
  !vercelJsonExists,
  vercelJsonExists
    ? 'frontend/vercel.json still exists alongside vercel.ts — only ONE Vercel configuration file is allowed (the JSON variant carried the hard-coded production API URL)'
    : 'vercel.ts is the single Vercel configuration file',
);

// --- VC-02: Vite SPA deployment settings ------------------------------------
check('VC-02a', config.framework === 'vite', `framework must be 'vite' (got '${String(config.framework)}')`);
check('VC-02b', config.installCommand === 'bun install', `installCommand must be 'bun install' (got '${String(config.installCommand)}')`);
check('VC-02c', config.buildCommand === 'bun run build', `buildCommand must be 'bun run build' (got '${String(config.buildCommand)}')`);
check('VC-02d', config.outputDirectory === 'dist', `outputDirectory must be 'dist' (got '${String(config.outputDirectory)}')`);

// --- VC-03: environment-resolved API proxy -----------------------------------
const routes = (config.routes ?? []) as Array<Record<string, unknown>>;
const apiRoute = routes.find((r) => r.src === '/api/(.*)');
check('VC-03a', Boolean(apiRoute), "an '/api/(.*)' route must exist (the SPA calls the backend through /api/*)");
if (apiRoute) {
  const dest = String(apiRoute.dest ?? '');
  check(
    'VC-03b',
    dest === `${CANARY}/$1`,
    `the API proxy destination must resolve from the API_TARGET environment variable (expected '${CANARY}/$1' with the canary set at import time, got '${dest}')`,
  );
  const hardCodedHost = /https:\/\/(?!validation-canary\.invalid)[a-z0-9.-]+(:\d+)?/i.test(dest);
  check(
    'VC-03c',
    !hardCodedHost,
    'the API proxy destination must NOT contain a hard-coded backend host — a literal host would make every preview deployment silently target that backend',
  );
} else {
  check('VC-03b', false, 'cannot validate API proxy destination without the route');
  check('VC-03c', false, 'cannot validate API proxy destination host without the route');
}

// --- VC-04: filesystem serving + SPA fallback --------------------------------
const filesystemHandle = routes.some((r) => r.handle === 'filesystem');
check('VC-04a', filesystemHandle, "a '{ handle: \"filesystem\" }' route must exist so real static files (assets/*, index.html) are served");
const spaFallback = routes.some((r) => r.src === '/(.*)' && r.dest === '/index.html');
check(
  'VC-04b',
  spaFallback,
  "the SPA fallback route ('/(.*)' → '/index.html') must exist — client-side routing deep links depend on it",
);

// --- VC-05: no credential-looking literals -----------------------------------
const serialized = JSON.stringify(config);
const credentialPattern = /(token|secret|password|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}/i;
check(
  'VC-05',
  !credentialPattern.test(serialized),
  'the Vercel configuration must not embed credential-looking literals — frontend hosting carries no secrets',
);

// --- VC-06: fail-closed without API_TARGET ------------------------------------
// Red-proof in a subprocess: importing the configuration without API_TARGET
// must throw (the deployment build fails rather than silently mis-targeting).
let failedClosed = false;
let failClosedMessage = '';
try {
  execFileSync(
    'bun',
    ['-e', "delete process.env.API_TARGET; await import('./frontend/vercel.ts'); console.error('NO_THROW'); process.exit(3);"],
    { cwd: new URL('../', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, API_TARGET: '' } },
  );
} catch (err) {
  const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
  failedClosed = !stderr.includes('NO_THROW');
  failClosedMessage = stderr.split('\n').find((l) => l.includes('API_TARGET')) ?? '';
}
check(
  'VC-06',
  failedClosed,
  failedClosed
    ? `importing without API_TARGET throws (fail-closed): ${failClosedMessage.slice(0, 140)}`
    : 'importing without API_TARGET did NOT throw — the build would silently deploy a mis-targeted API proxy',
);

// --- Report -------------------------------------------------------------------
for (const n of notes) console.log(`  ✓ ${n}`);
if (failures.length > 0) {
  console.error('');
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('');
  console.error(`Vercel configuration validation FAILED (${failures.length} violation(s)).`);
  process.exit(1);
}
console.log('');
console.log('Vercel configuration validation passed (VC-01..VC-06).');

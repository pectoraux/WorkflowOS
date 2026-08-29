/**
 * WorkflowOS frontend — programmatic Vercel deployment configuration.
 *
 * DEPLOYMENT HARDENING (production topology):
 *
 * Replaces the previous static `vercel.json`. The one behavioral change is
 * REQUIRED for environment separation: the `/api/*` proxy destination is no
 * longer hard-coded to the production Railway backend. It is resolved from
 * the per-environment `API_TARGET` project variable AT BUILD TIME:
 *
 *   - production environment → API_TARGET = the production Railway API
 *     (https://workflowos-production.up.railway.app)
 *   - preview environment    → API_TARGET = the PREVIEW API target, which is
 *     deliberately a non-production canary. Preview deployments must never
 *     mutate production WorkflowOS state, so they cannot silently inherit the
 *     production backend URL the way the old hard-coded rewrite made them.
 *
 * `vercel.ts` executes inside the deployment build, where Vercel injects the
 * project's environment variables for the deployment's target environment —
 * so a production build bakes the production API origin and a preview build
 * bakes the preview target. This is the documented purpose of programmatic
 * configuration ("generate configuration dynamically using environment
 * variables").
 *
 * FAIL-CLOSED: when API_TARGET is not set for the deploying environment, this
 * file THROWS — the build fails with an actionable message instead of
 * deploying a frontend whose /api proxy silently targets some default
 * backend. (The alternative runtime `$API_TARGET` route expansion was tested
 * against this project and left the placeholder unexpanded — DNS failure —
 * so the build-time resolution is used: deterministic and verifiable from
 * the build logs.)
 *
 * Everything else preserves the previous vercel.json behavior:
 *   - framework: vite; install `bun install`; build `bun run build`; output `dist`
 *   - `/api/(.*)` proxies to the backend with the `/api` prefix stripped
 *     (the backend serves its routes at the root — same contract as the
 *     docker-compose nginx proxy and the vite dev-server proxy)
 *   - SPA fallback: every non-asset path serves `/index.html`
 *     (client-side routing via react-router)
 *   - Vercel is frontend hosting ONLY — no backend business logic, no
 *     serverless API implementation, no secrets in this file.
 *
 * Low-level `routes` are used (not the higher-level `rewrites`) so the proxy
 * rule and the filesystem/SPA-fallback ordering are explicit; the two forms
 * cannot be mixed.
 */
import type { VercelConfig, RouteType } from '@vercel/config/v1';

const apiTarget = process.env.API_TARGET;
if (!apiTarget) {
  throw new Error(
    'API_TARGET is not set for this deployment environment. ' +
      'The WorkflowOS frontend proxies /api/* to the backend origin stored in ' +
      'API_TARGET (production: the Railway API; preview: the isolated preview canary). ' +
      'Refusing to build without it (fail-closed): a missing target must fail the ' +
      'build, never silently deploy a frontend whose API proxy points somewhere else. ' +
      'Set the API_TARGET environment variable for this environment in the Vercel project.',
  );
}
// Normalize: strip a trailing slash so the compiled destination is
// deterministic whether the variable is configured with one or not.
const apiOrigin = apiTarget.replace(/\/+$/, '');

const routes: RouteType[] = [
  // API proxy: `/api/projects/123` → `<API_TARGET>/projects/123`.
  // The backend is the authoritative Railway API (modular monolith).
  // NEVER hard-code a deployment-specific hostname here — that is what let
  // preview deployments silently mutate production state.
  { src: '/api/(.*)', dest: `${apiOrigin}/$1` },
  // Serve real files (assets/*, index.html at /) from the static build output.
  { handle: 'filesystem' },
  // SPA fallback: any remaining path serves the app shell (client-side
  // routing). Runs after filesystem handling so assets are never shadowed.
  { src: '/(.*)', dest: '/index.html' },
];

export const config: VercelConfig = {
  framework: 'vite',
  installCommand: 'bun install',
  buildCommand: 'bun run build',
  outputDirectory: 'dist',
  routes,
};

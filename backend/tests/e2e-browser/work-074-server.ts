/**
 * WORK-074 browser E2E harness — a standalone backend using pglite (real PG
 * WASM, in-process) + the full identity & access runtime, listening on port
 * 3001. The frontend Vite dev server proxies /api → :3001.
 *
 * Seeds: an org + a project so the ProjectListPage renders after login.
 *
 * Run: bun run tests/e2e-browser/work-074-server.ts
 */
import { buildRuntimeStack, buildRuntimeServer } from '../helpers/test-identity-runtime-stack.js';

async function main(): Promise<void> {
  const stack = await buildRuntimeStack();
  const server = await buildRuntimeServer(stack);

  // Seed an org + project for the ProjectListPage (owned by a seeded user).
  const { user } = await stack.emailProvider.signup({
    email: 'demo@example.com',
    password: 'demo-password-2026',
    displayName: 'Demo User',
  });
  const org = await stack.organizationRepository.create({ name: 'Demo Org' });
  await stack.membershipRepository.assign({
    userId: user.id, organizationId: org.id, roleId: 'owner',
  });
  const project = await stack.projectRepository.create({
    organizationId: org.id, name: 'Demo Project',
  });
  await stack.projectAccessRepository.grant({
    userId: user.id, projectId: project.id, roleId: 'owner',
  });

  await server.app.listen({ port: 3001, host: '0.0.0.0' });
  process.stdout.write('WORK-074 E2E backend listening on http://0.0.0.0:3001\n');
  process.stdout.write('  seeded user: demo@example.com / demo-password-2026\n');
  process.stdout.write(`  seeded org: ${org.id}\n`);
  process.stdout.write(`  seeded project: ${project.id}\n`);

  // Keep running until interrupted.
  process.on('SIGTERM', async () => { await server.close(); await stack.teardown(); process.exit(0); });
  process.on('SIGINT', async () => { await server.close(); await stack.teardown(); process.exit(0); });
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });

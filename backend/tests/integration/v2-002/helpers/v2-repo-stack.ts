import type { FastifyInstance } from 'fastify';
import { buildAuthStack, type TestAuthStack } from '../../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue, createLogger } from '@platform/index.js';
import {
  createWorkflowRepositoryService,
  membershipRepositoryAdapter,
  userDirectoryAdapter,
  type WorkflowRepositoryService,
} from '@root/v2/workflow-repository/index.js';
import type { User } from '@modules/users/index.js';

/**
 * V2-002 test stack.
 *
 * Wires the REAL product path for the WorkflowOS 2.0 workflow repository:
 * real PostgreSQL (pglite locally / real pg in CI), the real V1 identity +
 * membership stack consumed through its PUBLIC contracts, the real
 * WorkflowRepositoryService, and the real Fastify server (buildServer +
 * authPlugin) with the V2-002 repository routes registered.
 *
 * Requests are issued through `server.inject` (real Fastify HTTP semantics
 * without a long-running listener).
 *
 * Tenants:
 * - orgA: userA (owner role), userC (member role)
 * - orgB: userB (owner role)
 */
export interface V2RepoStack {
  stack: TestAuthStack;
  orgA: { id: string };
  orgB: { id: string };
  userA: User;
  userB: User;
  userC: User;
  keyA: string;
  keyB: string;
  keyC: string;
  service: WorkflowRepositoryService;
  server: FastifyInstance;
  teardown: () => Promise<void>;
}

export async function buildV2RepoStack(): Promise<V2RepoStack> {
  const stack = await buildAuthStack({
    WFOS_TEST_KEY_V2A: 'raw-key-v2-a',
    WFOS_TEST_KEY_V2B: 'raw-key-v2-b',
    WFOS_TEST_KEY_V2C: 'raw-key-v2-c',
  });
  const orgA = await stack.organizationRepository.create({ name: 'V2-002 Org A' });
  const orgB = await stack.organizationRepository.create({ name: 'V2-002 Org B' });
  const userA = await stack.userRepository.upsertByExternalId({
    externalId: 'v2-002-user-a',
    displayName: 'V2 User A',
  });
  const userB = await stack.userRepository.upsertByExternalId({
    externalId: 'v2-002-user-b',
    displayName: 'V2 User B',
  });
  const userC = await stack.userRepository.upsertByExternalId({
    externalId: 'v2-002-user-c',
    displayName: 'V2 User C',
  });
  await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
  await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
  await stack.membershipRepository.assign({ userId: userC.id, organizationId: orgA.id, roleId: 'member' });
  await stack.apiKeyProvisioner.provision({
    keyId: 'v2-002-key-a',
    secretRef: 'WFOS_TEST_KEY_V2A',
    externalId: 'v2-002-user-a',
    label: 'V2 User A',
    rawKey: 'raw-key-v2-a',
  });
  await stack.apiKeyProvisioner.provision({
    keyId: 'v2-002-key-b',
    secretRef: 'WFOS_TEST_KEY_V2B',
    externalId: 'v2-002-user-b',
    label: 'V2 User B',
    rawKey: 'raw-key-v2-b',
  });
  await stack.apiKeyProvisioner.provision({
    keyId: 'v2-002-key-c',
    secretRef: 'WFOS_TEST_KEY_V2C',
    externalId: 'v2-002-user-c',
    label: 'V2 User C',
    rawKey: 'raw-key-v2-c',
  });

  const service = createWorkflowRepositoryService({
    database: stack.db.client,
    membershipResolver: membershipRepositoryAdapter(stack.membershipRepository),
    userDirectory: userDirectoryAdapter(stack.userRepository),
  });

  const server = await buildServer({
    queue: new InMemoryQueue(),
    logger: createLogger({ level: 'warn' }),
    auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
    v2WorkflowRepository: { service },
  });

  return {
    stack,
    orgA,
    orgB,
    userA,
    userB,
    userC,
    keyA: 'raw-key-v2-a',
    keyB: 'raw-key-v2-b',
    keyC: 'raw-key-v2-c',
    service,
    server,
    teardown: async () => {
      await server.close();
      await stack.teardown();
    },
  };
}

/** Issue an authenticated repository API request through the real HTTP path. */
export async function callRepo(
  server: FastifyInstance,
  apiKey: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
}> {
  const options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    headers: Record<string, string>;
    payload?: Record<string, unknown>;
  } = {
    method,
    url,
    headers: { 'x-api-key': apiKey },
  };
  if (payload !== undefined) {
    options.payload = payload;
  }
  const res = await server.inject(options);
  let body: Record<string, unknown> = {};
  if (typeof res.body === 'string' && res.body.length > 0) {
    try {
      body = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      body = { raw: res.body };
    }
  }
  return { statusCode: res.statusCode, body };
}

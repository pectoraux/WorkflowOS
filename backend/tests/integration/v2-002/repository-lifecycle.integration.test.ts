import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildV2RepoStack, callRepo, type V2RepoStack } from './helpers/v2-repo-stack.js';

/**
 * V2-002 — workflow repository lifecycle, permissions and visibility.
 *
 * Regression set (V2-002 Work Order):
 * - workflow create/read/update lifecycle with owner/tenant and visibility;
 * - repository ownership, visibility and permissions remain explicit;
 * - tenant/private visibility cannot leak across scopes;
 * - registry-governed visibility identifiers only (no aliases);
 * - permission discrimination (read vs write vs manage).
 */
describe('V2-002 — repository lifecycle, permissions and visibility', () => {
  let s: V2RepoStack;
  let privateWorkflowId: string;
  let orgWorkflowId: string;
  let publicWorkflowId: string;

  beforeAll(async () => {
    s = await buildV2RepoStack();
    const created = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'Invoice triage',
      description: 'Triages invoices from the shared inbox',
      visibility: 'private',
    });
    expect(created.statusCode).toBe(201);
    privateWorkflowId = created.body.workflowId as string;

    const orgWf = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'Standup digest',
      description: 'Posts the daily standup digest',
      visibility: 'organization',
    });
    expect(orgWf.statusCode).toBe(201);
    orgWorkflowId = orgWf.body.workflowId as string;

    const pubWf = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'Public release checklist',
      description: 'Open release checklist',
      visibility: 'public',
    });
    expect(pubWf.statusCode).toBe(201);
    publicWorkflowId = pubWf.body.workflowId as string;
  });

  afterAll(async () => {
    await s.teardown();
  });

  it('creates a workflow with explicit owner, tenant, visibility and registry protocol fields', () => {
    expect(typeof privateWorkflowId).toBe('string');
    const read = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${privateWorkflowId}`);
    expect(read.statusCode).toBe(200);
    expect(read.body.ownerType).toBe('user');
    expect(read.body.ownerId).toBe(s.userA.id);
    expect(read.body.tenantId).toBe(s.orgA.id);
    expect(read.body.visibility).toBe('private');
    expect(read.body.lifecycleStatus).toBe('active');
    expect(read.body.currentVersionId).toBeNull();
    expect(read.body.forkedFrom).toBeNull();
    expect(read.body.protocolVersion).toBe('2.0');
    expect(read.body.createdBy).toBe(s.userA.id);
  });

  it('rejects non-registry visibility values (alias discrimination, fail closed)', async () => {
    for (const bad of ['org', 'PUBLIC', 'internal', 'team', 'shared']) {
      const res = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
        tenantId: s.orgA.id,
        name: `visibility probe ${bad}`,
        visibility: bad,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('validation');
    }
  });

  it('rejects creation by a non-member of the target tenant (fail closed)', async () => {
    const res = await callRepo(s.server, s.keyB, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'Cross-tenant smuggle',
      visibility: 'private',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('requires a non-empty name', async () => {
    const res = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: '   ',
      visibility: 'private',
    });
    expect(res.statusCode).toBe(400);
  });

  it('organization visibility is readable by same-tenant members but not other tenants', async () => {
    const memberRead = await callRepo(s.server, s.keyC, 'GET', `/v2/workflows/${orgWorkflowId}`);
    expect(memberRead.statusCode).toBe(200);
    expect(memberRead.body.visibility).toBe('organization');

    const crossTenant = await callRepo(s.server, s.keyB, 'GET', `/v2/workflows/${orgWorkflowId}`);
    expect(crossTenant.statusCode).toBe(404);
  });

  it('private visibility cannot leak across scopes', async () => {
    // userC is a member of orgA (same tenant) but private means no access
    // without an explicit grant.
    const sameTenantMember = await callRepo(s.server, s.keyC, 'GET', `/v2/workflows/${privateWorkflowId}`);
    expect(sameTenantMember.statusCode).toBe(404);
    // Cross-tenant user cannot read it either.
    const crossTenant = await callRepo(s.server, s.keyB, 'GET', `/v2/workflows/${privateWorkflowId}`);
    expect(crossTenant.statusCode).toBe(404);
  });

  it('public visibility is readable cross-tenant', async () => {
    const res = await callRepo(s.server, s.keyB, 'GET', `/v2/workflows/${publicWorkflowId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.visibility).toBe('public');
  });

  it('unauthenticated requests are rejected', async () => {
    const res = await s.server.inject({ method: 'GET', url: `/v2/workflows/${publicWorkflowId}` });
    expect(res.statusCode).toBe(401);
  });

  it('discriminates read vs write vs manage permissions', async () => {
    // userB gets no access to the private workflow without a grant.
    const before = await callRepo(s.server, s.keyB, 'GET', `/v2/workflows/${privateWorkflowId}`);
    expect(before.statusCode).toBe(404);

    // Owner grants userB the writer role (explicit permission).
    const grant = await callRepo(
      s.server,
      s.keyA,
      'POST',
      `/v2/workflows/${privateWorkflowId}/collaborators`,
      { userId: s.userB.id, role: 'writer' },
    );
    expect(grant.statusCode).toBe(201);
    expect(grant.body.role).toBe('writer');

    // Explicit grant beats private visibility for reading.
    const read = await callRepo(s.server, s.keyB, 'GET', `/v2/workflows/${privateWorkflowId}`);
    expect(read.statusCode).toBe(200);

    // Writer may update repository metadata (name/description).
    const metaUpdate = await callRepo(s.server, s.keyB, 'PATCH', `/v2/workflows/${privateWorkflowId}`, {
      name: 'Invoice triage (renamed by writer)',
    });
    expect(metaUpdate.statusCode).toBe(200);
    expect(metaUpdate.body.name).toBe('Invoice triage (renamed by writer)');

    // Writer may NOT change visibility or lifecycle (manage-only).
    const visibilityUpdate = await callRepo(s.server, s.keyB, 'PATCH', `/v2/workflows/${privateWorkflowId}`, {
      visibility: 'organization',
    });
    expect(visibilityUpdate.statusCode).toBe(403);
    const archive = await callRepo(s.server, s.keyB, 'PATCH', `/v2/workflows/${privateWorkflowId}`, {
      lifecycleStatus: 'archived',
    });
    expect(archive.statusCode).toBe(403);

    // Reader may read but not write metadata.
    const grantReader = await callRepo(
      s.server,
      s.keyA,
      'POST',
      `/v2/workflows/${privateWorkflowId}/collaborators`,
      { userId: s.userC.id, role: 'reader' },
    );
    expect(grantReader.statusCode).toBe(201);
    const readerRead = await callRepo(s.server, s.keyC, 'GET', `/v2/workflows/${privateWorkflowId}`);
    expect(readerRead.statusCode).toBe(200);
    const readerWrite = await callRepo(s.server, s.keyC, 'PATCH', `/v2/workflows/${privateWorkflowId}`, {
      name: 'reader edit attempt',
    });
    expect(readerWrite.statusCode).toBe(403);

    // Revoking removes the access again (explicit, not sticky).
    const revoke = await callRepo(
      s.server,
      s.keyA,
      'DELETE',
      `/v2/workflows/${privateWorkflowId}/collaborators/${s.userC.id}`,
    );
    expect(revoke.statusCode).toBe(204);
    const afterRevoke = await callRepo(s.server, s.keyC, 'GET', `/v2/workflows/${privateWorkflowId}`);
    expect(afterRevoke.statusCode).toBe(404);
  });

  it('owner can manage visibility, lifecycle and collaborator grants', async () => {
    const collaborators = await callRepo(
      s.server,
      s.keyA,
      'GET',
      `/v2/workflows/${privateWorkflowId}/collaborators`,
    );
    expect(collaborators.statusCode).toBe(200);
    const rows = collaborators.body.collaborators as Array<Record<string, unknown>>;
    // The owner's own row + the writer grant from the previous test.
    const roles = new Map(rows.map((r) => [r.userId as string, r.role as string]));
    expect(roles.get(s.userA.id)).toBe('owner');
    expect(roles.get(s.userB.id)).toBe('writer');

    const visibility = await callRepo(s.server, s.keyA, 'PATCH', `/v2/workflows/${privateWorkflowId}`, {
      visibility: 'organization',
    });
    expect(visibility.statusCode).toBe(200);
    expect(visibility.body.visibility).toBe('organization');

    const archive = await callRepo(s.server, s.keyA, 'PATCH', `/v2/workflows/${privateWorkflowId}`, {
      lifecycleStatus: 'archived',
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.body.lifecycleStatus).toBe('archived');
  });

  it('only manage permission may grant collaborators', async () => {
    const grantAttempt = await callRepo(
      s.server,
      s.keyB,
      'POST',
      `/v2/workflows/${publicWorkflowId}/collaborators`,
      { userId: s.userC.id, role: 'reader' },
    );
    // userB can read the public workflow but holds no manage grant.
    expect(grantAttempt.statusCode).toBe(403);
  });

  it('rejects granting unknown users and invalid roles (fail closed)', async () => {
    const unknownUser = await callRepo(
      s.server,
      s.keyA,
      'POST',
      `/v2/workflows/${publicWorkflowId}/collaborators`,
      { userId: '00000000-0000-4000-8000-0000000000ff', role: 'reader' },
    );
    expect(unknownUser.statusCode).toBe(400);

    const invalidRole = await callRepo(
      s.server,
      s.keyA,
      'POST',
      `/v2/workflows/${publicWorkflowId}/collaborators`,
      { userId: s.userC.id, role: 'admin' },
    );
    expect(invalidRole.statusCode).toBe(400);
  });

  it('cannot revoke the owner of record', async () => {
    const res = await callRepo(
      s.server,
      s.keyA,
      'DELETE',
      `/v2/workflows/${publicWorkflowId}/collaborators/${s.userA.id}`,
    );
    expect(res.statusCode).toBe(409);
  });
});

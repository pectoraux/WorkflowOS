import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  canonicalizeJson,
  computeContentDigest,
} from '@root/v2/workflow-repository/index.js';
import { buildV2RepoStack, callRepo, type V2RepoStack } from './helpers/v2-repo-stack.js';

/**
 * V2-002 — installation + immutable version pinning.
 *
 * Regression set (V2-002 Work Order):
 * - installing a workflow pins an immutable version;
 * - deployment remains pinned after a newer version exists;
 * - install/uninstall/enable/disable semantics without mutating historical
 *   versions;
 * - re-install converges without silently re-pinning;
 * - explicit re-pin is customer-controlled;
 * - installation access is tenant-scoped;
 * - the installation execution path fails closed when disabled.
 */

const CONTENT_V1 = {
  title: 'Daily GitHub PR triage',
  steps: [
    { id: 'list-open-prs', capability: 'github.repository.read' },
    { id: 'post-triage-comment', capability: 'github.pull_request.create' },
  ],
};

const CONTENT_V2 = {
  ...CONTENT_V1,
  steps: [...CONTENT_V1.steps, { id: 'merge-approved', capability: 'github.pull_request.merge' }],
};

const CONTENT_V3 = {
  ...CONTENT_V2,
  steps: [...CONTENT_V2.steps, { id: 'close-stale', capability: 'github.repository.read' }],
};

describe('V2-002 — install + version pinning', () => {
  let s: V2RepoStack;
  let workflowId: string;
  let v1: Record<string, unknown>;
  let v2: Record<string, unknown>;
  let v3: Record<string, unknown>;
  let v1Id: string;
  let v2Id: string;
  let v3Id: string;
  let privateWorkflowId: string;
  let privateV1Id: string;

  beforeAll(async () => {
    s = await buildV2RepoStack();
    const created = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'Pinnable workflow',
      visibility: 'public',
    });
    workflowId = created.body.workflowId as string;
    v1 = (await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, { content: CONTENT_V1 })).body;
    v2 = (await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, { content: CONTENT_V2 })).body;
    v3 = (await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, { content: CONTENT_V3 })).body;
    v1Id = v1.workflowVersionId as string;
    v2Id = v2.workflowVersionId as string;
    v3Id = v3.workflowVersionId as string;

    const priv = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'Private pinnable workflow',
      visibility: 'private',
    });
    privateWorkflowId = priv.body.workflowId as string;
    const privV = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${privateWorkflowId}/versions`, {
      content: CONTENT_V1,
    });
    privateV1Id = privV.body.workflowVersionId as string;
  });

  afterAll(async () => {
    await s.teardown();
  });

  it('installing a workflow pins an immutable version', async () => {
    const install = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/installations`, {
      tenantId: s.orgA.id,
      workflowVersionId: v1Id,
    });
    expect(install.statusCode).toBe(201);
    expect(install.body.pinnedVersionId).toBe(v1Id);
    expect(install.body.status).toBe('enabled');
    expect(install.body.workflowId).toBe(workflowId);
    expect(install.body.tenantId).toBe(s.orgA.id);
    expect(install.body.installedBy).toBe(s.userA.id);
  });

  it('a newer version never silently mutates an installed version', async () => {
    const installations = await callRepo(
      s.server,
      s.keyA,
      'GET',
      `/v2/workflows/${workflowId}/installations`,
    );
    const installationId = (installations.body.installations as Array<Record<string, unknown>>)[0]!
      .installationId as string;

    // A publisher edit (v3) already exists. Resolve through the execution
    // path an executor would consume.
    const target = await callRepo(s.server, s.keyA, 'GET', `/v2/installations/${installationId}/execution-target`);
    expect(target.statusCode).toBe(200);
    const version = target.body.version as Record<string, unknown>;
    expect(version.workflowVersionId).toBe(v1Id);
    expect(version.contentDigest).toBe(v1.contentDigest);
    // The pinned content is byte-identical to v1's content and its digest
    // recomputes exactly — an installed version cannot be silently mutated.
    expect(canonicalizeJson(version.content)).toBe(canonicalizeJson(CONTENT_V1));
    expect(computeContentDigest(version.content)).toBe(v1.contentDigest);
  });

  it('re-installing the same workflow into the same tenant converges without re-pinning', async () => {
    const first = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/installations`, {
      tenantId: s.orgA.id,
      workflowVersionId: v1Id,
    });
    expect(first.statusCode).toBe(201);

    // The same tenant asks to install a DIFFERENT version afterwards: the
    // existing installation converges (same identity) and its pin is NOT
    // silently changed — re-pinning is an explicit customer action.
    const again = await callRepo(s.server, s.keyC, 'POST', `/v2/workflows/${workflowId}/installations`, {
      tenantId: s.orgA.id,
      workflowVersionId: v2Id,
    });
    expect(again.statusCode).toBe(201);
    expect(again.body.installationId).toBe(first.body.installationId);
    expect(again.body.pinnedVersionId).toBe(v1Id);
  });

  it('explicit re-pin is customer-controlled and survives later publisher edits', async () => {
    const installations = await callRepo(
      s.server,
      s.keyA,
      'GET',
      `/v2/workflows/${workflowId}/installations`,
    );
    const installationId = (installations.body.installations as Array<Record<string, unknown>>)[0]!
      .installationId as string;

    const rePin = await callRepo(s.server, s.keyA, 'PATCH', `/v2/installations/${installationId}`, {
      pinnedVersionId: v2Id,
    });
    expect(rePin.statusCode).toBe(200);
    expect(rePin.body.pinnedVersionId).toBe(v2Id);

    // Publisher ships v3 (already committed) — the customer pin stays at v2.
    const target = await callRepo(s.server, s.keyA, 'GET', `/v2/installations/${installationId}/execution-target`);
    expect((target.body.version as Record<string, unknown>).workflowVersionId).toBe(v2Id);
    expect(computeContentDigest((target.body.version as Record<string, unknown>).content)).toBe(
      v2.contentDigest,
    );

    // Cross-workflow re-pin attempts are rejected.
    const cross = await callRepo(s.server, s.keyA, 'PATCH', `/v2/installations/${installationId}`, {
      pinnedVersionId: privateV1Id,
    });
    expect(cross.statusCode).toBe(400);
  });

  it('enable/disable transitions are idempotent and execution fails closed when disabled', async () => {
    const install = await callRepo(s.server, s.keyC, 'POST', `/v2/workflows/${workflowId}/installations`, {
      tenantId: s.orgA.id,
      workflowVersionId: v3Id,
    });
    // Converged install (orgA already installed this workflow): pin stays v2
    // after the earlier explicit re-pin.
    expect(install.body.pinnedVersionId).toBe(v2Id);
    const installationId = install.body.installationId as string;

    const disable = await callRepo(s.server, s.keyC, 'PATCH', `/v2/installations/${installationId}`, {
      status: 'disabled',
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.body.status).toBe('disabled');

    // Idempotent disable.
    const disableAgain = await callRepo(s.server, s.keyC, 'PATCH', `/v2/installations/${installationId}`, {
      status: 'disabled',
    });
    expect(disableAgain.statusCode).toBe(200);

    // Execution resolution fails closed while disabled.
    const denied = await callRepo(s.server, s.keyA, 'GET', `/v2/installations/${installationId}/execution-target`);
    expect(denied.statusCode).toBe(409);
    expect(denied.body.error).toBe('conflict');

    const enable = await callRepo(s.server, s.keyC, 'PATCH', `/v2/installations/${installationId}`, {
      status: 'enabled',
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.body.status).toBe('enabled');

    const target = await callRepo(s.server, s.keyA, 'GET', `/v2/installations/${installationId}/execution-target`);
    expect(target.statusCode).toBe(200);
  });

  it('uninstall removes the installation, never the immutable version', async () => {
    const installB = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${workflowId}/installations`, {
      tenantId: s.orgB.id,
      workflowVersionId: v2Id,
    });
    expect(installB.statusCode).toBe(201);
    expect(installB.body.tenantId).toBe(s.orgB.id);
    const installationB = installB.body.installationId as string;

    const uninstall = await callRepo(s.server, s.keyB, 'DELETE', `/v2/installations/${installationB}`);
    expect(uninstall.statusCode).toBe(204);

    const gone = await callRepo(s.server, s.keyB, 'GET', `/v2/installations/${installationB}`);
    expect(gone.statusCode).toBe(404);

    // The pinned version itself remains immutable and addressable.
    const version = await callRepo(s.server, s.keyB, 'GET', `/v2/workflows/${workflowId}/versions/${v2Id}`);
    expect(version.statusCode).toBe(200);
    expect(computeContentDigest(version.body.content)).toBe(v2.contentDigest);
  });

  it('installation access is tenant-scoped (no cross-tenant leak)', async () => {
    const installations = await callRepo(
      s.server,
      s.keyA,
      'GET',
      `/v2/workflows/${workflowId}/installations`,
    );
    const orgAInstallation = (installations.body.installations as Array<Record<string, unknown>>)[0]!
      .installationId as string;

    // userB (orgB) cannot even observe orgA's installation.
    const read = await callRepo(s.server, s.keyB, 'GET', `/v2/installations/${orgAInstallation}`);
    expect(read.statusCode).toBe(404);
    const mutate = await callRepo(s.server, s.keyB, 'PATCH', `/v2/installations/${orgAInstallation}`, {
      status: 'disabled',
    });
    expect(mutate.statusCode).toBe(404);
    const target = await callRepo(s.server, s.keyB, 'GET', `/v2/installations/${orgAInstallation}/execution-target`);
    expect(target.statusCode).toBe(404);
  });

  it('installing requires tenant membership and read access (fail closed)', async () => {
    // userB is not a member of orgA → forbidden (existence of the tenant is
    // not a secret; the action is).
    const notMember = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${workflowId}/installations`, {
      tenantId: s.orgA.id,
      workflowVersionId: v1Id,
    });
    expect(notMember.statusCode).toBe(403);

    // userB cannot read the private workflow at all → 404 (no leak).
    const noRead = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${privateWorkflowId}/installations`, {
      tenantId: s.orgB.id,
      workflowVersionId: privateV1Id,
    });
    expect(noRead.statusCode).toBe(404);

    // Unknown version → 404.
    const unknown = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/installations`, {
      tenantId: s.orgA.id,
      workflowVersionId: 'wfv_' + '9'.repeat(64),
    });
    expect(unknown.statusCode).toBe(404);
  });
});

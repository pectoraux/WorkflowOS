import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  canonicalizeJson,
  computeContentDigest,
} from '@root/v2/workflow-repository/index.js';
import { buildV2RepoStack, callRepo, type V2RepoStack } from './helpers/v2-repo-stack.js';

/**
 * V2-002 — fork semantics: independent identity, preserved provenance.
 *
 * Regression set (V2-002 Work Order + constitution §14):
 * - forking creates a NEW Workflow identity (never a mutation of the source);
 * - provenance (source workflow + source version) is preserved;
 * - the fork's initial version carries the same immutable content but a
 *   different version identity;
 * - forks do NOT silently copy private source data (collaborators,
 *   installations) — only the version content document transfers;
 * - forking requires read access on the source;
 * - the fork can be edited and installed independently of the source.
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

describe('V2-002 — fork identity and provenance', () => {
  let s: V2RepoStack;
  let sourceId: string;
  let v1: Record<string, unknown>;
  let v2: Record<string, unknown>;
  let v2Id: string;
  let privateSourceId: string;

  beforeAll(async () => {
    s = await buildV2RepoStack();
    const created = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'Forkable source',
      description: 'Source description',
      visibility: 'public',
    });
    sourceId = created.body.workflowId as string;
    v1 = (await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${sourceId}/versions`, { content: CONTENT_V1 })).body;
    v2 = (await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${sourceId}/versions`, { content: CONTENT_V2 })).body;
    v2Id = v2.workflowVersionId as string;

    // Give the source an explicit collaborator + an installation (private
    // source state that must NOT transfer to forks).
    await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${sourceId}/collaborators`, {
      userId: s.userC.id,
      role: 'reader',
    });
    await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${sourceId}/installations`, {
      tenantId: s.orgA.id,
      workflowVersionId: v2Id,
    });

    const priv = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'Private fork source',
      visibility: 'private',
    });
    privateSourceId = priv.body.workflowId as string;
    await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${privateSourceId}/versions`, {
      content: CONTENT_V1,
    });
  });

  afterAll(async () => {
    await s.teardown();
  });

  it('forks create a new workflow identity with preserved provenance', async () => {
    const fork = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${sourceId}/fork`, {
      tenantId: s.orgB.id,
    });
    expect(fork.statusCode).toBe(201);

    const forkWorkflow = fork.body.workflow as Record<string, unknown>;
    const forkVersion = fork.body.initialVersion as Record<string, unknown>;
    expect(forkWorkflow.workflowId).not.toBe(sourceId);
    expect(forkWorkflow.ownerType).toBe('user');
    expect(forkWorkflow.ownerId).toBe(s.userB.id);
    expect(forkWorkflow.tenantId).toBe(s.orgB.id);
    expect(forkWorkflow.name).toBe('Forkable source');
    expect(forkWorkflow.forkedFrom).toEqual({
      workflowId: sourceId,
      workflowVersionId: v2Id,
    });

    // Same immutable content, but a DIFFERENT version identity: fork identity
    // is new, content is preserved.
    expect(forkVersion.contentDigest).toBe(v2.contentDigest);
    expect(forkVersion.workflowVersionId).not.toBe(v2Id);
    expect(forkVersion.parentVersionId).toBeNull();
    expect(forkVersion.provenance).toEqual({
      origin: 'fork',
      forkedFrom: { workflowId: sourceId, workflowVersionId: v2Id },
    });
    expect(canonicalizeJson(forkVersion.content)).toBe(canonicalizeJson(CONTENT_V2));

    // The fork's current pointer references the fork's own first version.
    expect(forkWorkflow.currentVersionId).toBe(forkVersion.workflowVersionId);
  });

  it('forks default to private visibility (never inherit source visibility implicitly)', async () => {
    const fork = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${sourceId}/fork`, {
      tenantId: s.orgB.id,
    });
    const forkWorkflowId = (fork.body.workflow as Record<string, unknown>).workflowId as string;
    const read = await callRepo(s.server, s.keyB, 'GET', `/v2/workflows/${forkWorkflowId}`);
    expect(read.statusCode).toBe(200);
    expect(read.body.visibility).toBe('private');
  });

  it('forks do not silently copy private source data (collaborators, installations)', async () => {
    const fork = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${sourceId}/fork`, {
      tenantId: s.orgB.id,
    });
    const forkWorkflowId = (fork.body.workflow as Record<string, unknown>).workflowId as string;

    // Only the forker holds a (owner) grant on the fork — the source's
    // collaborator (userC, reader) did not transfer.
    const collaborators = await callRepo(s.server, s.keyB, 'GET', `/v2/workflows/${forkWorkflowId}/collaborators`);
    const rows = collaborators.body.collaborators as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.userId as string).sort()).toEqual([s.userB.id]);
    // userC (a source collaborator) cannot read the private fork.
    const leaked = await callRepo(s.server, s.keyC, 'GET', `/v2/workflows/${forkWorkflowId}`);
    expect(leaked.statusCode).toBe(404);

    // The source's orgA installation did not transfer to the fork.
    const installations = await callRepo(s.server, s.keyB, 'GET', `/v2/workflows/${forkWorkflowId}/installations`);
    expect(installations.statusCode).toBe(200);
    expect(installations.body.installations).toEqual([]);
  });

  it('forking requires read access (private sources do not leak)', async () => {
    const denied = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${privateSourceId}/fork`, {
      tenantId: s.orgB.id,
    });
    expect(denied.statusCode).toBe(404);
  });

  it('forking requires membership of the target tenant (fail closed)', async () => {
    const denied = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${sourceId}/fork`, {
      tenantId: s.orgA.id,
    });
    expect(denied.statusCode).toBe(403);
  });

  it('the fork can be edited independently of the source', async () => {
    const fork = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${sourceId}/fork`, {
      tenantId: s.orgB.id,
    });
    const forkWorkflowId = (fork.body.workflow as Record<string, unknown>).workflowId as string;
    const forkV1Id = (fork.body.initialVersion as Record<string, unknown>).workflowVersionId as string;

    const forkEdit = {
      ...CONTENT_V2,
      steps: [...CONTENT_V2.steps, { id: 'fork-specific-step', capability: 'github.repository.read' }],
    };
    const commit = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${forkWorkflowId}/versions`, {
      content: forkEdit,
      parentVersionId: forkV1Id,
    });
    expect(commit.statusCode).toBe(201);
    expect(commit.body.parentVersionId).toBe(forkV1Id);
    expect(commit.body.contentDigest).not.toBe(v2.contentDigest);

    // The source is untouched: same versions, same current pointer, same
    // immutable content.
    const sourceVersions = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${sourceId}/versions`);
    expect((sourceVersions.body.versions as unknown[]).length).toBe(2);
    const sourceRead = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${sourceId}`);
    expect(sourceRead.body.currentVersionId).toBe(v2Id);
    const sourceV2 = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${sourceId}/versions/${v2Id}`);
    expect(canonicalizeJson(sourceV2.body.content)).toBe(canonicalizeJson(CONTENT_V2));
  });

  it('installing from the fork is independent of the source', async () => {
    const fork = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${sourceId}/fork`, {
      tenantId: s.orgB.id,
    });
    const forkWorkflowId = (fork.body.workflow as Record<string, unknown>).workflowId as string;
    const forkV1Id = (fork.body.initialVersion as Record<string, unknown>).workflowVersionId as string;

    const install = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${forkWorkflowId}/installations`, {
      tenantId: s.orgB.id,
      workflowVersionId: forkV1Id,
    });
    expect(install.statusCode).toBe(201);
    const installationId = install.body.installationId as string;

    // Publisher continues editing the SOURCE — the fork installation's pin
    // is unaffected.
    const sourceEdit = {
      ...CONTENT_V2,
      steps: [...CONTENT_V2.steps, { id: 'source-only-step', capability: 'github.repository.read' }],
    };
    const newSourceVersion = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${sourceId}/versions`, {
      content: sourceEdit,
    });
    expect(newSourceVersion.statusCode).toBe(201);

    const target = await callRepo(s.server, s.keyB, 'GET', `/v2/installations/${installationId}/execution-target`);
    expect(target.statusCode).toBe(200);
    const version = target.body.version as Record<string, unknown>;
    expect(version.workflowVersionId).toBe(forkV1Id);
    expect(computeContentDigest(version.content)).toBe(v2.contentDigest);
  });

  it('a fork of a fork preserves the provenance chain', async () => {
    const fork1 = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${sourceId}/fork`, {
      tenantId: s.orgB.id,
    });
    const fork1Id = (fork1.body.workflow as Record<string, unknown>).workflowId as string;
    const fork1V1Id = (fork1.body.initialVersion as Record<string, unknown>).workflowVersionId as string;

    // userB forks their own (private) fork — provenance now points at fork1.
    const fork2 = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${fork1Id}/fork`, {
      tenantId: s.orgB.id,
    });
    expect(fork2.statusCode).toBe(201);
    const fork2Workflow = fork2.body.workflow as Record<string, unknown>;
    expect(fork2Workflow.forkedFrom).toEqual({
      workflowId: fork1Id,
      workflowVersionId: fork1V1Id,
    });
    const fork2Version = fork2.body.initialVersion as Record<string, unknown>;
    expect(fork2Version.provenance).toEqual({
      origin: 'fork',
      forkedFrom: { workflowId: fork1Id, workflowVersionId: fork1V1Id },
    });
  });

  it('forks honor explicit name and visibility overrides', async () => {
    const fork = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${sourceId}/fork`, {
      tenantId: s.orgB.id,
      name: 'My own fork',
      visibility: 'public',
    });
    const forkWorkflow = fork.body.workflow as Record<string, unknown>;
    expect(forkWorkflow.name).toBe('My own fork');
    expect(forkWorkflow.visibility).toBe('public');
  });

  it('forking a specific historical version pins that version as provenance', async () => {
    const fork = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${sourceId}/fork`, {
      tenantId: s.orgB.id,
      sourceVersionId: v1.workflowVersionId as string,
    });
    const forkWorkflow = fork.body.workflow as Record<string, unknown>;
    const forkVersion = fork.body.initialVersion as Record<string, unknown>;
    expect(forkWorkflow.forkedFrom).toEqual({
      workflowId: sourceId,
      workflowVersionId: v1.workflowVersionId,
    });
    expect(forkVersion.contentDigest).toBe(v1.contentDigest);
    expect(canonicalizeJson(forkVersion.content)).toBe(canonicalizeJson(CONTENT_V1));
  });
});

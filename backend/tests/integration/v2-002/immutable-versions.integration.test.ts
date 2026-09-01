import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  canonicalizeJson,
  computeContentDigest,
} from '@root/v2/workflow-repository/index.js';
import { buildV2RepoStack, callRepo, type V2RepoStack } from './helpers/v2-repo-stack.js';

/**
 * V2-002 — immutable WorkflowVersion persistence, addressability and ancestry.
 *
 * Regression set (V2-002 Work Order):
 * - old version remains unchanged after edit;
 * - duplicate version content converges deterministically;
 * - version rows are append-only at the PostgreSQL level (negative proof
 *   that an installed version cannot be silently mutated);
 * - versions are addressable by id and by content digest;
 * - deterministic round-trip: stored content recomputes to the stored digest;
 * - ancestry/version-history via parent lineage;
 * - protocol compatibility checked at the version boundary (fail closed).
 */

const CONTENT_V1 = {
  title: 'Daily GitHub PR triage',
  steps: [
    { id: 'list-open-prs', name: 'List open pull requests', capability: 'github.repository.read' },
    { id: 'post-triage-comment', name: 'Post triage summary', capability: 'github.pull_request.create' },
  ],
};

const CONTENT_V2 = {
  ...CONTENT_V1,
  steps: [
    ...CONTENT_V1.steps,
    { id: 'merge-approved', name: 'Merge approved PRs', capability: 'github.pull_request.merge' },
  ],
};

const CONTENT_V3 = {
  ...CONTENT_V2,
  steps: [
    ...CONTENT_V2.steps,
    { id: 'close-stale', name: 'Close stale PRs', capability: 'github.repository.read' },
  ],
};

describe('V2-002 — immutable versions, addressability, ancestry', () => {
  let s: V2RepoStack;
  let workflowId: string;
  let otherWorkflowId: string;
  let v1: Record<string, unknown>;
  let v2: Record<string, unknown>;
  let v3: Record<string, unknown>;
  let v1Id: string;
  let v2Id: string;
  let v3Id: string;

  beforeAll(async () => {
    s = await buildV2RepoStack();
    const created = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'Immutable version probe',
      visibility: 'public',
    });
    workflowId = created.body.workflowId as string;

    const other = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'Other workflow',
      visibility: 'public',
    });
    otherWorkflowId = other.body.workflowId as string;
    const otherV = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${otherWorkflowId}/versions`, {
      content: { title: 'other', steps: [] },
    });
    expect(otherV.statusCode).toBe(201);

    v1 = (await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, {
      content: CONTENT_V1,
      message: 'initial version',
    })).body;
    v2 = (await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, {
      content: CONTENT_V2,
      message: 'add merge step',
    })).body;
    v3 = (await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, {
      content: CONTENT_V3,
      message: 'add stale close step',
    })).body;
    v1Id = v1.workflowVersionId as string;
    v2Id = v2.workflowVersionId as string;
    v3Id = v3.workflowVersionId as string;
  });

  afterAll(async () => {
    await s.teardown();
  });

  it('commits addressable immutable versions with content digests and parent ancestry', () => {
    expect(v1Id).toMatch(/^wfv_[0-9a-f]{64}$/);
    expect(v1.contentDigest).toBe(computeContentDigest(CONTENT_V1));
    expect(v1.parentVersionId).toBeNull();
    expect(v1.protocolVersion).toBe('2.0');
    expect(v1.provenance).toEqual({ origin: 'authored', forkedFrom: null });
    expect(v1.content).toEqual(CONTENT_V1);

    expect(v2.parentVersionId).toBe(v1Id);
    expect(v3.parentVersionId).toBe(v2Id);
    expect(v2Id).not.toBe(v1Id);
    expect(v3Id).not.toBe(v2Id);
    expect(v2.contentDigest).not.toBe(v1.contentDigest);

    // The workflow's current pointer follows the newest commit.
    const wf = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${workflowId}`);
    expect(wf.body.currentVersionId).toBe(v3Id);
  });

  it('old version remains unchanged after edit (byte-identical content + digest)', async () => {
    const read = await callRepo(s.server, s.keyB, 'GET', `/v2/workflows/${workflowId}/versions/${v1Id}`);
    expect(read.statusCode).toBe(200);
    expect(read.body.contentDigest).toBe(v1.contentDigest);
    // Byte-identical canonical content (not just deep-equal).
    expect(canonicalizeJson(read.body.content)).toBe(canonicalizeJson(CONTENT_V1));
    // Round-trip determinism: the stored content recomputes to the stored
    // digest (the pinned-version integrity check executors rely on).
    expect(computeContentDigest(read.body.content)).toBe(read.body.contentDigest);
    expect(read.body.parentVersionId).toBeNull();
  });

  it('version rows are append-only at the PostgreSQL level (negative mutation proof)', async () => {
    // No repository API mutates a version; this attempts a raw SQL mutation
    // directly — the database must reject it (V2-002 immutability invariant).
    await expect(
      s.stack.db.client.query(
        'UPDATE wfos_v2_workflow_versions SET content = $1 WHERE workflow_version_id = $2',
        [JSON.stringify({ title: 'tampered' }), v1Id],
      ),
    ).rejects.toThrow();

    await expect(
      s.stack.db.client.query('DELETE FROM wfos_v2_workflow_versions WHERE workflow_version_id = $1', [
        v1Id,
      ]),
    ).rejects.toThrow();

    // The version is untouched after the rejected mutation attempts.
    const read = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${workflowId}/versions/${v1Id}`);
    expect(read.statusCode).toBe(200);
    expect(canonicalizeJson(read.body.content)).toBe(canonicalizeJson(CONTENT_V1));
  });

  it('duplicate version content converges deterministically (idempotent commit)', async () => {
    const before = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${workflowId}/versions`);
    const countBefore = (before.body.versions as unknown[]).length;

    // Re-deliver the exact same content with the same parent identity
    // inputs (v1's original commit had no parent).
    const recommit = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, {
      content: CONTENT_V1,
      parentVersionId: null,
      message: 'duplicate delivery of the same content',
    });
    expect(recommit.statusCode).toBe(201);
    expect(recommit.body.workflowVersionId).toBe(v1Id);
    expect(recommit.body.contentDigest).toBe(v1.contentDigest);

    const after = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${workflowId}/versions`);
    expect((after.body.versions as unknown[]).length).toBe(countBefore);

    // A converged re-delivery does not move the current pointer.
    const wf = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${workflowId}`);
    expect(wf.body.currentVersionId).toBe(v3Id);
  });

  it('versions are addressable by id and resolvable by content digest', async () => {
    const byId = await callRepo(s.server, s.keyB, 'GET', `/v2/workflows/${workflowId}/versions/${v2Id}`);
    expect(byId.statusCode).toBe(200);
    expect(byId.body.workflowVersionId).toBe(v2Id);

    const byDigest = await callRepo(
      s.server,
      s.keyB,
      'GET',
      `/v2/workflows/${workflowId}/versions-by-digest/${v2.contentDigest as string}`,
    );
    expect(byDigest.statusCode).toBe(200);
    expect(byDigest.body.workflowVersionId).toBe(v2Id);
    expect(byDigest.body.contentDigest).toBe(v2.contentDigest);

    const unknownDigest = await callRepo(
      s.server,
      s.keyB,
      'GET',
      `/v2/workflows/${workflowId}/versions-by-digest/${'f'.repeat(64)}`,
    );
    expect(unknownDigest.statusCode).toBe(404);

    const unknownId = await callRepo(
      s.server,
      s.keyB,
      'GET',
      `/v2/workflows/${workflowId}/versions/${'wfv_' + '0'.repeat(64)}`,
    );
    expect(unknownId.statusCode).toBe(404);
  });

  it('lists versions deterministically and walks the lineage newest → root', async () => {
    const list = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${workflowId}/versions`);
    const versions = list.body.versions as Array<Record<string, unknown>>;
    expect(versions.map((v) => v.workflowVersionId)).toEqual([v1Id, v2Id, v3Id]);

    const lineage = await callRepo(
      s.server,
      s.keyB,
      'GET',
      `/v2/workflows/${workflowId}/versions/${v3Id}/lineage`,
    );
    expect(lineage.statusCode).toBe(200);
    const chain = lineage.body.lineage as Array<Record<string, unknown>>;
    expect(chain.map((v) => v.workflowVersionId)).toEqual([v3Id, v2Id, v1Id]);

    const rootLineage = await callRepo(
      s.server,
      s.keyB,
      'GET',
      `/v2/workflows/${workflowId}/versions/${v1Id}/lineage`,
    );
    expect((rootLineage.body.lineage as unknown[]).map((v) => (v as Record<string, unknown>).workflowVersionId)).toEqual([
      v1Id,
    ]);
  });

  it('rejects unsupported protocol versions (fail closed)', async () => {
    for (const bad of ['1.0', '3.0', '']) {
      const res = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, {
        content: CONTENT_V1,
        protocolVersion: bad,
      });
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toBe('unsupported-protocol');
    }
  });

  it('rejects invalid parents (unknown parent, parent from another workflow)', async () => {
    const unknown = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, {
      content: CONTENT_V1,
      parentVersionId: 'wfv_' + 'e'.repeat(64),
    });
    expect(unknown.statusCode).toBe(404);

    const otherWorkflowVersions = await callRepo(
      s.server,
      s.keyA,
      'GET',
      `/v2/workflows/${otherWorkflowId}/versions`,
    );
    const foreignId = (otherWorkflowVersions.body.versions as Array<Record<string, unknown>>)[0]!
      .workflowVersionId as string;
    const foreign = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, {
      content: CONTENT_V1,
      parentVersionId: foreignId,
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.body.error).toBe('validation');
  });

  it('rejects commits to archived workflows (conflict)', async () => {
    const wf = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'Archive probe',
      visibility: 'private',
    });
    const id = wf.body.workflowId as string;
    const commit = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${id}/versions`, {
      content: CONTENT_V1,
    });
    expect(commit.statusCode).toBe(201);
    await callRepo(s.server, s.keyA, 'PATCH', `/v2/workflows/${id}`, { lifecycleStatus: 'archived' });
    const rejected = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${id}/versions`, {
      content: CONTENT_V2,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.body.error).toBe('conflict');
  });

  it('rejects non-object content (workflow documents are JSON objects)', async () => {
    for (const bad of [[1, 2], 'string', 42, null, true]) {
      const res = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, {
        content: bad,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('validation');
    }
  });

  it('commits require write permission (reader/outsider discrimination)', async () => {
    // Outsider (no read access at all): 404 to avoid existence leaks.
    const outsider = await callRepo(s.server, s.keyC, 'POST', `/v2/workflows/${workflowId}/versions`, {
      content: CONTENT_V1,
    });
    // userC can read the public workflow but holds no write grant.
    expect(outsider.statusCode).toBe(403);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeJson,
  computeContentDigest,
} from '@root/v2/workflow-repository/index.js';
import { buildV2RepoStack, callRepo, type V2RepoStack } from './helpers/v2-repo-stack.js';

/**
 * V2-002 — feature-boundary dogfooding experiment (dogfooding protocol).
 *
 * Work Order V2-002 / dogfooding-protocol.md required experiment:
 * "Create a workflow, edit it, create an immutable version, fork it, install
 * it, and execute it. Verify old installations remain pinned."
 *
 * The experiment runs the REAL product path end-to-end: the real Fastify
 * server + auth plugin, real PostgreSQL (pglite locally / real pg in CI),
 * real V1 identity/membership consumed through public contracts, and the
 * real V2-002 repository API. The workflow content is a realistic workflow
 * document whose capability identifiers are checked against the canonical
 * V2-CTRL-003 protocol registry.
 *
 * "Execute" is exercised as the installation execution path an executor
 * consumes (V2-002 owns repository/install persistence, not the execution
 * engine): the executor resolves the installation to its pinned immutable
 * version and verifies the content digest — exactly the resolution contract
 * the later V2-005 execution runtime consumes.
 *
 * Evidence: spec/architecture/v2/dogfooding-evidence/V2-002-dogfooding.md
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const registry = JSON.parse(
  readFileSync(
    join(REPO_ROOT, 'spec', 'architecture', 'v2', 'V2-CTRL-003-protocol-registry.json'),
    'utf-8',
  ),
) as { capabilities: Record<string, string[]> };

const REGISTRY_CAPABILITIES = new Set(Object.values(registry.capabilities).flat());

/** A real workflow document (opaque semantic payload to V2-002). */
const PR_TRIAGE_V1 = {
  title: 'Daily GitHub PR triage',
  description: 'Summarizes open pull requests and posts a triage comment.',
  trigger: { kind: 'schedule', schedule: 'daily-09:00' },
  steps: [
    { id: 'list-open-prs', name: 'List open pull requests', capability: 'github.repository.read' },
    { id: 'post-triage-comment', name: 'Post triage summary comment', capability: 'github.pull_request.create' },
  ],
};

/** The edited workflow (publisher edit → new immutable version). */
const PR_TRIAGE_V2 = {
  ...PR_TRIAGE_V1,
  steps: [
    ...PR_TRIAGE_V1.steps,
    { id: 'merge-approved', name: 'Merge PRs approved by owners', capability: 'github.pull_request.merge' },
  ],
};

/** A later publisher edit (v3) after customers already installed v1/v2. */
const PR_TRIAGE_V3 = {
  ...PR_TRIAGE_V2,
  steps: [
    ...PR_TRIAGE_V2.steps,
    { id: 'close-stale', name: 'Close stale pull requests', capability: 'github.repository.read' },
  ],
};

describe('V2-002 — dogfooding: create → edit → version → fork → install → execute', () => {
  let s: V2RepoStack;
  let workflowId: string;
  let v1: Record<string, unknown>;
  let v2: Record<string, unknown>;
  let v3: Record<string, unknown>;
  let orgAInstallationId: string;
  let orgBInstallationId: string;
  let forkWorkflowId: string;
  let forkVersionId: string;
  let forkInstallationId: string;

  beforeAll(async () => {
    s = await buildV2RepoStack();
  });

  afterAll(async () => {
    await s.teardown();
  });

  it('step 0 — the real workflow uses only canonical registry capability identifiers', () => {
    for (const content of [PR_TRIAGE_V1, PR_TRIAGE_V2, PR_TRIAGE_V3]) {
      for (const step of content.steps) {
        expect(REGISTRY_CAPABILITIES.has(step.capability)).toBe(true);
      }
    }
  });

  it('step 1 — create the workflow and commit the first immutable version', async () => {
    const created = await callRepo(s.server, s.keyA, 'POST', '/v2/workflows', {
      tenantId: s.orgA.id,
      name: 'daily-pr-triage',
      description: PR_TRIAGE_V1.description,
      visibility: 'public',
    });
    expect(created.statusCode).toBe(201);
    workflowId = created.body.workflowId as string;

    const commit = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, {
      content: PR_TRIAGE_V1,
      message: 'initial published version',
    });
    expect(commit.statusCode).toBe(201);
    v1 = commit.body;
    expect(v1.contentDigest).toBe(computeContentDigest(PR_TRIAGE_V1));
  });

  it('step 2 — edit the workflow: a NEW immutable version is created, the old one is unchanged', async () => {
    const commit = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, {
      content: PR_TRIAGE_V2,
      message: 'add merge step',
    });
    expect(commit.statusCode).toBe(201);
    v2 = commit.body;
    expect(v2.workflowVersionId).not.toBe(v1.workflowVersionId);
    expect(v2.parentVersionId).toBe(v1.workflowVersionId);

    const old = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${workflowId}/versions/${v1.workflowVersionId as string}`);
    expect(canonicalizeJson(old.body.content)).toBe(canonicalizeJson(PR_TRIAGE_V1));
    expect(computeContentDigest(old.body.content)).toBe(v1.contentDigest);
  });

  it('step 3 — install BOTH versions (two tenants pin different immutable versions)', async () => {
    const installA = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/installations`, {
      tenantId: s.orgA.id,
      workflowVersionId: v1.workflowVersionId as string,
    });
    expect(installA.statusCode).toBe(201);
    orgAInstallationId = installA.body.installationId as string;

    const installB = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${workflowId}/installations`, {
      tenantId: s.orgB.id,
      workflowVersionId: v2.workflowVersionId as string,
    });
    expect(installB.statusCode).toBe(201);
    orgBInstallationId = installB.body.installationId as string;
    expect(installB.body.pinnedVersionId).toBe(v2.workflowVersionId);
  });

  it('step 4 — fork the workflow: new identity, preserved provenance, identical content', async () => {
    const fork = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${workflowId}/fork`, {
      tenantId: s.orgB.id,
      name: 'daily-pr-triage (orgB fork)',
    });
    expect(fork.statusCode).toBe(201);
    const forkWorkflow = fork.body.workflow as Record<string, unknown>;
    forkWorkflowId = forkWorkflow.workflowId as string;
    const forkVersion = fork.body.initialVersion as Record<string, unknown>;
    forkVersionId = forkVersion.workflowVersionId as string;

    expect(forkWorkflow.forkedFrom).toEqual({
      workflowId,
      workflowVersionId: v2.workflowVersionId,
    });
    expect(forkVersion.contentDigest).toBe(v2.contentDigest);
    expect(forkVersion.workflowVersionId).not.toBe(v2.workflowVersionId);
    expect(canonicalizeJson(forkVersion.content)).toBe(canonicalizeJson(PR_TRIAGE_V2));
  });

  it('step 5 — install the fork in the forking tenant', async () => {
    const install = await callRepo(s.server, s.keyB, 'POST', `/v2/workflows/${forkWorkflowId}/installations`, {
      tenantId: s.orgB.id,
      workflowVersionId: forkVersionId,
    });
    expect(install.statusCode).toBe(201);
    forkInstallationId = install.body.installationId as string;
  });

  it('step 6 — publisher ships a third version AFTER installs/fork', async () => {
    const commit = await callRepo(s.server, s.keyA, 'POST', `/v2/workflows/${workflowId}/versions`, {
      content: PR_TRIAGE_V3,
      message: 'add stale-PR close step',
    });
    expect(commit.statusCode).toBe(201);
    v3 = commit.body;

    // Every historical version remains immutable and byte-identical.
    for (const [version, content] of [
      [v1, PR_TRIAGE_V1],
      [v2, PR_TRIAGE_V2],
    ] as Array<[Record<string, unknown>, typeof PR_TRIAGE_V1]>) {
      const read = await callRepo(s.server, s.keyA, 'GET', `/v2/workflows/${workflowId}/versions/${version.workflowVersionId as string}`);
      expect(canonicalizeJson(read.body.content)).toBe(canonicalizeJson(content));
      expect(computeContentDigest(read.body.content)).toBe(version.contentDigest);
    }
  });

  it('step 7 — EXECUTE the installation path: old installations remain pinned', async () => {
    // The execution resolution path an executor (V2-005, later work)
    // consumes: resolve the installation → pinned immutable version.
    const targets: Array<[string, Record<string, unknown>, typeof PR_TRIAGE_V1]> = [
      [orgAInstallationId, v1, PR_TRIAGE_V1],
      [orgBInstallationId, v2, PR_TRIAGE_V2],
      [forkInstallationId, { workflowVersionId: forkVersionId, contentDigest: v2.contentDigest }, PR_TRIAGE_V2],
    ];
    for (const [installationId, pinned, content] of targets) {
      // orgB's installations are only visible to orgB members.
      const who = installationId === orgAInstallationId ? s.keyA : s.keyB;
      const resolved = await callRepo(s.server, who, 'GET', `/v2/installations/${installationId}/execution-target`);
      expect(resolved.statusCode).toBe(200);
      const version = resolved.body.version as Record<string, unknown>;
      // Pinned to the ORIGINAL immutable version — not the publisher's v3.
      expect(version.workflowVersionId).toBe(pinned.workflowVersionId);
      expect(version.contentDigest).not.toBe(v3.contentDigest);
      expect(version.contentDigest).toBe(pinned.contentDigest);
      // The executor's integrity check: the resolved content recomputes to
      // the pinned digest (execute exactly what was installed).
      expect(computeContentDigest(version.content)).toBe(pinned.contentDigest);
      expect(canonicalizeJson(version.content)).toBe(canonicalizeJson(content));
    }
  });
});

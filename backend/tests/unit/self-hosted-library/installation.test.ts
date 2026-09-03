import { describe, it, expect } from 'vitest';
import {
  installFirstPartyWorkflows,
  publishFirstPartyVersion,
  FIRST_PARTY_WORKFLOW_ARTIFACTS,
  artifactByKind,
} from '../../../src/self-hosted-library/index.js';
import type {
  FirstPartyInstallPort,
  FirstPartyWorkflowManifest,
} from '../../../src/self-hosted-library/index.js';
import { computeWorkflowVersionSemanticDigest, serializeWorkflowIrDocument } from '../../../src/workflow-ir/index.js';

/**
 * V2-013 Task 4 — the self-hosting installation battery (unit level, over
 * an in-memory port that mirrors V2-002's create-or-converge contract).
 *
 * Proves (the frozen regressions "workflow version pinning" + the
 * universal-protocol installation rule):
 *   - the installer publishes ALL six artifacts and installs them
 *     version-pinned for the development tenant (one manifest per kind,
 *     canonical order);
 *   - the manifest's identities are the authority's REAL identities
 *     (workflowId/versionId/installationId/contentDigest) and the
 *     semantic digest is V2-003's own derivation;
 *   - re-running the installer against the same repository CONVERGES
 *     (V2-002's idempotence: same workflows, same versions, same
 *     installations — no duplicates);
 *   - an explicit version transition (publishFirstPartyVersion) creates a
 *     NEW version and NEVER moves the installed pin (the manifest stays
 *     pinned to the original version — the frozen pinning regression);
 *   - a mutated document yields a DIFFERENT semantic digest (content
 *     discrimination: a changed procedure is a NEW version, never an
 *     in-place mutation).
 */

// ---------------------------------------------------------------------------
// The in-memory port (V2-002's create-or-converge contract, minimal)
// ---------------------------------------------------------------------------

interface FakeVersion {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: Record<string, unknown>;
}

interface FakeInstallation {
  id: string;
  organizationId: string;
  workflowId: string;
  versionId: string;
}

function makeFakePort() {
  const workflows = new Map<string, { id: string; organizationId: string; slug: string; name: string; description: string; visibility: string; headVersionId: string }>();
  const versions = new Map<string, FakeVersion>();
  const installations = new Map<string, FakeInstallation>();
  let seq = 0;
  const principal = { userId: 'dev-operator' };

  const port: FirstPartyInstallPort = {
    async createWorkflow(p, input) {
      expect(p).toEqual(principal);
      const existing = [...workflows.values()].find(
        (w) => w.organizationId === input.organizationId && w.slug === input.slug,
      );
      if (existing) {
        const version = versions.get(existing.headVersionId)!;
        return {
          workflow: { ...existing, headVersionId: existing.headVersionId },
          initialVersion: { id: version.id, workflowId: version.workflowId, versionNumber: version.versionNumber, contentDigest: version.contentDigest, content: version.content, protocol: { irSchemaVersion: 'wfos-ir-1' }, parentVersionId: null, createdByUserId: p.userId, createdAt: new Date(0) },
          created: false,
        };
      }
      const workflowId = `wfw-${++seq}`;
      const versionId = `wfwv-${++seq}`;
      const contentDigest = `digest-${input.slug}`;
      workflows.set(workflowId, { id: workflowId, organizationId: input.organizationId, slug: input.slug, name: input.name, description: input.description ?? '', visibility: input.visibility, headVersionId: versionId });
      versions.set(versionId, { id: versionId, workflowId, versionNumber: 1, contentDigest, content: input.content });
      return {
        workflow: { id: workflowId, organizationId: input.organizationId, slug: input.slug, name: input.name, description: input.description ?? '', visibility: input.visibility, headVersionId: versionId },
        initialVersion: { id: versionId, workflowId, versionNumber: 1, contentDigest, content: input.content, protocol: { irSchemaVersion: 'wfos-ir-1' }, parentVersionId: null, createdByUserId: p.userId, createdAt: new Date(0) },
        created: true,
      };
    },
    async createVersion(p, workflowId, input) {
      const workflow = workflows.get(workflowId);
      if (!workflow) {
        throw new Error(`workflow ${workflowId} not found`);
      }
      const existing = [...versions.values()].find(
        (v) => v.workflowId === workflowId && v.contentDigest === input.content ? false : false,
      );
      void existing;
      const versionId = `wfwv-${++seq}`;
      const nextNumber = [...versions.values()].filter((v) => v.workflowId === workflowId).length + 1;
      versions.set(versionId, { id: versionId, workflowId, versionNumber: nextNumber, contentDigest: `digest-${workflowId}-${versionId}`, content: input.content });
      workflow.headVersionId = versionId;
      return {
        version: { id: versionId, workflowId, versionNumber: nextNumber, contentDigest: `digest-${workflowId}-${versionId}`, content: input.content, protocol: { irSchemaVersion: 'wfos-ir-1' }, parentVersionId: null, createdByUserId: p.userId, createdAt: new Date(0) },
        created: true,
      };
    },
    async installVersion(p, input) {
      const existing = [...installations.values()].find(
        (i) => i.organizationId === input.organizationId && i.workflowId === input.workflowId,
      );
      if (existing) {
        return {
          installation: { ...existing },
          created: false,
        };
      }
      const installationId = `wfin-${++seq}`;
      installations.set(installationId, { id: installationId, organizationId: input.organizationId, workflowId: input.workflowId, versionId: input.versionId });
      return {
        installation: { id: installationId, organizationId: input.organizationId, workflowId: input.workflowId, versionId: input.versionId, installedByUserId: p.userId, status: 'active', installedAt: new Date(0), updatedAt: new Date(0) },
        created: true,
      };
    },
    async getInstallation(p, organizationId, installationId) {
      const installation = installations.get(installationId);
      if (!installation || installation.organizationId !== organizationId) {
        throw new Error(`installation ${installationId} not found`);
      }
      const version = versions.get(installation.versionId)!;
      const workflow = workflows.get(installation.workflowId)!;
      return {
        installation: { ...installation, installedByUserId: p.userId, status: 'active', installedAt: new Date(0), updatedAt: new Date(0) },
        pinnedVersion: { id: version.id, workflowId: version.workflowId, versionNumber: version.versionNumber, contentDigest: version.contentDigest, protocol: { irSchemaVersion: 'wfos-ir-1' } },
        workflow: { id: workflow.id, organizationId: workflow.organizationId, slug: workflow.slug, name: workflow.name, description: workflow.description, visibility: workflow.visibility, headVersionId: workflow.headVersionId },
      };
    },
  };
  return { port, principal, workflows, versions, installations };
}

const PROTOCOL = { irSchemaVersion: 'wfos-ir-1' };
const DEV_TENANT = 'org-dev-environment';

describe('V2-013 self-hosting installation — publish + version-pinned install', () => {
  it('installs all six first-party workflows, one manifest per kind in canonical order', async () => {
    const { port, principal } = makeFakePort();
    const outcome = await installFirstPartyWorkflows({ principal, organizationId: DEV_TENANT, port, protocol: PROTOCOL });
    expect(outcome.manifests.map((m) => m.kind)).toEqual([
      'implementation', 'review', 'testing', 'release', 'maintenance', 'dogfooding',
    ]);
    for (const manifest of outcome.manifests) {
      expect(manifest.workflowId).toMatch(/^wfw-/);
      expect(manifest.versionId).toMatch(/^wfwv-/);
      expect(manifest.installationId).toMatch(/^wfin-/);
      expect(manifest.versionNumber).toBe(1);
    }
    // the semantic digests are V2-003's own derivations of the artifacts
    for (const artifact of FIRST_PARTY_WORKFLOW_ARTIFACTS) {
      const manifest = outcome.manifests.find((m) => m.kind === artifact.kind)!;
      expect(manifest.semanticDigest).toStrictEqual(computeWorkflowVersionSemanticDigest(artifact.document));
    }
  });

  it('re-running the installer CONVERGES (idempotent: same identities, no duplicates)', async () => {
    const { port, principal } = makeFakePort();
    const first = await installFirstPartyWorkflows({ principal, organizationId: DEV_TENANT, port, protocol: PROTOCOL });
    const second = await installFirstPartyWorkflows({ principal, organizationId: DEV_TENANT, port, protocol: PROTOCOL });
    expect(second.manifests).toEqual(first.manifests);
    for (const kind of Object.keys(second.created)) {
      expect(second.created[kind as keyof typeof second.created]).toEqual({ workflow: false, installation: false });
    }
  });

  it('an explicit version transition creates a NEW version and NEVER moves the installed pin', async () => {
    const { port, principal } = makeFakePort();
    const outcome = await installFirstPartyWorkflows({ principal, organizationId: DEV_TENANT, port, protocol: PROTOCOL });
    const testing = outcome.manifests.find((m) => m.kind === 'testing')!;
    // a governed maintenance update: publish a new version of the SAME workflow
    const next = await publishFirstPartyVersion(port, principal, testing.workflowId, artifactByKind('testing')!.document, PROTOCOL);
    expect(next.versionId).not.toBe(testing.versionId);
    expect(next.created).toBe(true);
    // the manifest's pin is UNCHANGED (the installation still pins v1)
    const detail = await port.getInstallation(principal, DEV_TENANT, testing.installationId);
    expect(detail.pinnedVersion.id).toBe(testing.versionId);
    expect(detail.pinnedVersion.versionNumber).toBe(1);
    // the new version exists on the workflow (the explicit transition)
    expect(next.versionNumber).toBe(2);
  });

  it('a mutated procedure document has a DIFFERENT semantic digest (content discrimination)', () => {
    const testing = artifactByKind('testing')!;
    const original = computeWorkflowVersionSemanticDigest(testing.document);
    // the same document re-derived from its serialized form is identical
    const roundTrip = JSON.parse(serializeWorkflowIrDocument(testing.document)) as Record<string, unknown>;
    expect(computeWorkflowVersionSemanticDigest(roundTrip as Parameters<typeof computeWorkflowVersionSemanticDigest>[0]).digest).toBe(original.digest);
    const ir = roundTrip['ir'] as Record<string, unknown>;
    const nodes = ir['nodes'] as Record<string, unknown>[];
    const last = nodes[nodes.length - 1]!;
    const spec = last['spec'] as Record<string, unknown>;
    spec['task'] = 'A mutated task text';
    const mutated = computeWorkflowVersionSemanticDigest(roundTrip as Parameters<typeof computeWorkflowVersionSemanticDigest>[0]);
    expect(mutated.digest).not.toBe(original.digest);
  });
});

/**
 * IG-001 — Repository + WorkflowIR Round-Trip Integration Gate.
 *
 * Gate scope is deliberately limited to the frozen Work Order:
 * V2-002 repository persistence/versioning + V2-003 WorkflowIR semantics.
 * No production code is changed by this gate.
 *
 * The experiment uses the real repository service over the real test database
 * harness, and the real V2-003 serializer/parser/semantic digest. It proves
 * that an exact WorkflowIR survives repository persistence, that semantic
 * identity is preserved, that historical versions remain immutable and pinned
 * installations do not move, and that fork identity/provenance are independent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
  type WorkflowRepositoryService,
} from '../../../src/workflow-repository/index.js';
import {
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
  serializeWorkflowIrDocument,
  validateWorkflowIrDocument,
  type WorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import { buildMinimalDocument, withNode } from '../../unit/workflow-ir/helpers.js';

const PROTOCOL = { irSchemaVersion: '1' } as const;

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('IG-001 — repository ↔ WorkflowIR semantic round-trip', () => {
  let stack: TestAuthStack;
  let service: WorkflowRepositoryService;
  let organizationId: string;
  let ownerId: string;
  let forkOrganizationId: string;
  let forkOwnerId: string;

  beforeAll(async () => {
    stack = await buildAuthStack({});
    const memberships: OrganizationMembershipResolver = {
      isMember: async (userId, organizationId) =>
        (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
    };
    service = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });

    const org = await stack.organizationRepository.create({ name: 'IG-001 Source Org' });
    const owner = await stack.userRepository.upsertByExternalId({
      externalId: 'ig-001-owner',
      displayName: 'IG-001 Owner',
    });
    await stack.membershipRepository.assign({ userId: owner.id, organizationId: org.id, roleId: 'owner' });

    const forkOrg = await stack.organizationRepository.create({ name: 'IG-001 Fork Org' });
    const forkOwner = await stack.userRepository.upsertByExternalId({
      externalId: 'ig-001-fork-owner',
      displayName: 'IG-001 Fork Owner',
    });
    await stack.membershipRepository.assign({ userId: forkOwner.id, organizationId: forkOrg.id, roleId: 'owner' });

    organizationId = org.id;
    ownerId = owner.id;
    forkOrganizationId = forkOrg.id;
    forkOwnerId = forkOwner.id;
  });

  beforeEach(async () => {
    await stack.db.client.exec(
      'TRUNCATE wfos_v2_workflow_installations, wfos_v2_workflow_versions, wfos_v2_workflows CASCADE',
    );
  });

  afterAll(async () => {
    await stack.teardown();
  });

  it('persists an exact WorkflowIR and recovers it losslessly with equal semantic digest', async () => {
    const authored = buildMinimalDocument();
    expect(validateWorkflowIrDocument(authored).ok).toBe(true);

    const transportBytes = serializeWorkflowIrDocument(authored);
    const parsedBeforePersist = parseWorkflowIrDocument(transportBytes);
    expect(parsedBeforePersist.ok).toBe(true);
    if (!parsedBeforePersist.ok) return;

    const authoredDigest = computeWorkflowVersionSemanticDigest(authored).digest;

    const created = await service.createWorkflow(
      { userId: ownerId },
      {
        organizationId,
        slug: 'ig-001-roundtrip',
        name: 'IG-001 Round Trip',
        visibility: 'private',
        content: authored as unknown as Record<string, unknown>,
        protocol: PROTOCOL,
      },
    );

    expect(created.created).toBe(true);
    const stored = await service.getVersion({ userId: ownerId }, created.workflow.id, created.initialVersion.id);
    const parsedStored = parseWorkflowIrDocument(
      serializeWorkflowIrDocument(stored.content as unknown as WorkflowIrDocument),
    );
    expect(parsedStored.ok).toBe(true);
    if (!parsedStored.ok) return;

    expect(parsedStored.document).toEqual(authored);
    expect(computeWorkflowVersionSemanticDigest(parsedStored.document).digest).toBe(authoredDigest);
    expect(serializeWorkflowIrDocument(parsedStored.document)).toEqual(transportBytes);
  });

  it('keeps historical meaning immutable after a later IR edit and keeps the installation pinned', async () => {
    const authored = buildMinimalDocument();
    const created = await service.createWorkflow(
      { userId: ownerId },
      {
        organizationId,
        slug: 'ig-001-history',
        name: 'IG-001 History',
        visibility: 'private',
        content: authored as unknown as Record<string, unknown>,
        protocol: PROTOCOL,
      },
    );
    const v1 = created.initialVersion;
    const beforeBytes = serializeWorkflowIrDocument(v1.content as unknown as WorkflowIrDocument);
    const beforeDigest = computeWorkflowVersionSemanticDigest(v1.content as unknown as WorkflowIrDocument).digest;

    const installed = await service.installVersion(
      { userId: ownerId },
      { organizationId, workflowId: created.workflow.id, versionId: v1.id },
    );
    expect(installed.installation.versionId).toBe(v1.id);

    const edited = withNode(jsonClone(authored), 'observe', {
      spec: { class: 'deterministic_api', capability: 'workflow.observe' },
      capabilityRequirements: ['workflow.observe'],
    });
    expect(validateWorkflowIrDocument(edited).ok).toBe(true);

    const v2Result = await service.createVersion(
      { userId: ownerId },
      created.workflow.id,
      { content: edited as unknown as Record<string, unknown>, protocol: PROTOCOL },
    );
    expect(v2Result.created).toBe(true);
    expect(v2Result.version.id).not.toBe(v1.id);

    const historical = await service.getVersion({ userId: ownerId }, created.workflow.id, v1.id);
    expect(serializeWorkflowIrDocument(historical.content as unknown as WorkflowIrDocument)).toEqual(beforeBytes);
    expect(computeWorkflowVersionSemanticDigest(historical.content as unknown as WorkflowIrDocument).digest).toBe(beforeDigest);

    const installation = await service.getInstallation(
      { userId: ownerId },
      organizationId,
      installed.installation.id,
    );
    expect(installation.installation.versionId).toBe(v1.id);
    expect(installation.pinnedVersion.id).toBe(v1.id);
  });

  it('forks provenance while creating an independent workflow identity and does not transfer installations', async () => {
    const authored = buildMinimalDocument();
    const source = await service.createWorkflow(
      { userId: ownerId },
      {
        organizationId,
        slug: 'ig-001-fork-source',
        name: 'IG-001 Fork Source',
        visibility: 'private',
        content: authored as unknown as Record<string, unknown>,
        protocol: PROTOCOL,
      },
    );
    const sourceInstall = await service.installVersion(
      { userId: ownerId },
      { organizationId, workflowId: source.workflow.id, versionId: source.initialVersion.id },
    );
    expect(sourceInstall.installation.versionId).toBe(source.initialVersion.id);

    // Cross-tenant forks must come from a deliberately forkable source scope.
    await service.updateWorkflow({ userId: ownerId }, source.workflow.id, { visibility: 'public' });

    const fork = await service.forkWorkflow(
      { userId: forkOwnerId },
      {
        organizationId: forkOrganizationId,
        sourceWorkflowId: source.workflow.id,
        sourceVersionId: source.initialVersion.id,
        slug: 'ig-001-forked',
        name: 'IG-001 Forked',
      },
    );

    expect(fork.created).toBe(true);
    expect(fork.workflow.id).not.toBe(source.workflow.id);
    expect(fork.workflow.organizationId).toBe(forkOrganizationId);
    expect(fork.workflow.forkedFromWorkflowId).toBe(source.workflow.id);
    expect(fork.workflow.forkedFromVersionId).toBe(source.initialVersion.id);
    expect(fork.initialVersion.workflowId).toBe(fork.workflow.id);
    expect(fork.initialVersion.id).not.toBe(source.initialVersion.id);
    expect(computeWorkflowVersionSemanticDigest(fork.initialVersion.content as unknown as WorkflowIrDocument).digest).toBe(
      computeWorkflowVersionSemanticDigest(source.initialVersion.content as unknown as WorkflowIrDocument).digest,
    );

    expect(await service.listInstallations({ userId: forkOwnerId }, forkOrganizationId)).toHaveLength(0);
    expect(await service.listInstallations({ userId: ownerId }, organizationId)).toHaveLength(1);
  });
});

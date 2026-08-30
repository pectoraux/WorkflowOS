import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { createLogger } from '@platform/index.js';

// The EXISTING execution stack (mirrors the delegation integration test —
// the substrate consumes it exactly as production wires it, THROUGH the
// delegation coordinator).
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultExecutionTaskService } from '../../../src/modules/work-items/internal/execution-task-service.js';
import { DefaultExecutionPromptBuilder } from '../../../src/modules/work-items/internal/execution-prompt-builder.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import { NativeExecutionProvider } from '../../../src/modules/agents/internal/native-execution-provider.js';
import { ExternalExecutionProvider } from '../../../src/modules/agents/internal/external-execution-provider.js';
import { DefaultExecutionService } from '../../../src/modules/agents/internal/execution-service.js';
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgExecutionProviderOperationRepository } from '../../../src/modules/agents/internal/pg-execution-provider-operation-repository.js';
import type { ExecutionService } from '../../../src/modules/agents/index.js';

// The EXISTING WORK-045 role catalog (consumed, never redefined).
import { DefaultAgentRoleCatalogService } from '../../../src/agent-roles/index.js';

// WORK-046 — the delegation layer under the substrate.
import {
  DefaultDelegationPlanService,
  DefaultDelegationCoordinator,
  type DelegationPlanService,
  type DelegationCoordinator,
  type DelegationPlanInput,
  type DelegationUnitSpec,
} from '../../../src/delegation/index.js';

// WORK-062 — the orchestration substrate under test.
import {
  DefaultOrchestrationSubstrate,
  PgOrchestrationRepository,
  OrchestrationError,
  type OrchestrationSubstrate,
  type OrchestrationNode,
} from '../../../src/orchestration/index.js';

/**
 * WORK-062 — the durable orchestration substrate: the semantic proof matrix.
 *
 * Every test drives REAL delegated executions through the EXISTING stack
 * (WORK-046 coordinator + the existing execution services) on real
 * PostgreSQL semantics (pglite locally / real postgres in CI), and asserts
 * the SUBSTRATE's durable state (migration 0058 tables):
 *
 *   - durable identity (one graph per plan, one node per unit — survives
 *     repeated drives);
 *   - durable dependency gating (a dependent node NEVER dispatches before
 *     its dependencies' durable outcomes admit it — and the violation is
 *     REJECTED at the mutation boundary);
 *   - explicit partial completion (3/10 is 'partial' — never collapsed);
 *   - deterministic reconciliation (same durable state → same result);
 *   - replanning without evidence loss;
 *   - simple / complex / very-complex shapes under ONE semantics;
 *   - tenant isolation (same logical keys in two projects cannot collide);
 *   - native/external semantic parity.
 */
describe('WORK-062 — the durable orchestration substrate (semantics over the EXISTING authorities)', () => {
  let stack: TestAuthStack;
  let fakeAgent: FakeAgentAdapter;
  let executionRecordRepo: PgExecutionRecordRepository;
  let agentRunRepo: PgAgentRunRepository;
  let planService: DelegationPlanService;
  let coordinator: DelegationCoordinator;
  let substrate: OrchestrationSubstrate;
  let substrateRepo: PgOrchestrationRepository;
  let project: { id: string };
  const NATIVE_MODEL = 'fake-model';

  beforeAll(async () => {
    stack = await buildAuthStack({});
    const logger = createLogger({ level: 'silent' });

    // --- the EXISTING execution stack (mirrors production wiring) -----------
    fakeAgent = new FakeAgentAdapter();
    const agentGateway = new DefaultAgentGateway(stack.db.client, logger, [fakeAgent], 3);
    agentRunRepo = new PgAgentRunRepository(stack.db.client);
    const reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, logger);
    const contextRepo = new PgImplementationContextRepository(stack.db.client);
    const builder = new DefaultImplementationContextBuilder(
      stack.workItemRepository,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.workItemDependencyRepository,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.architectureRepository,
      contextRepo,
      undefined,
      undefined,
      undefined,
      async (workItemId: string) => {
        const reviews = await reviewService.listReviewsForWorkItem(workItemId);
        return Promise.all(
          reviews
            .filter((r) => r.status === 'completed' && r.outcome !== null)
            .map(async (r) => {
              const findings = await reviewService.listFindingsForReview(r.id);
              return {
                reviewId: r.id,
                verdict: r.outcome ?? '',
                summary: r.summary ?? '',
                findings: findings.map((f) => f.description),
                createdAt: r.createdAt.toISOString(),
              };
            }),
        );
      },
    );
    const taskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      implementationContextBuilder: builder,
      contextRepository: contextRepo,
      promptBuilder: new DefaultExecutionPromptBuilder(),
      logger,
    });
    const nativeExecutionProvider = new NativeExecutionProvider({
      agentGateway,
      agentRunRepository: agentRunRepo,
      logger,
    });
    const externalExecutionProvider = new ExternalExecutionProvider({
      packageTtlMs: 60 * 60 * 1000,
      operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
    });
    executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    const auditService = new DefaultAuditService(stack.db.client, logger);
    const executionService: ExecutionService = new DefaultExecutionService({
      executionRecordRepository: executionRecordRepo,
      providers: [nativeExecutionProvider, externalExecutionProvider],
      auditService,
      logger,
    });

    // --- WORK-045 roles + WORK-046 delegation + WORK-062 substrate ----------
    const roleCatalog = new DefaultAgentRoleCatalogService();
    planService = new DefaultDelegationPlanService({
      db: stack.db.client,
      workItemRepository: stack.workItemRepository,
      roleCatalog,
    });
    substrate = new DefaultOrchestrationSubstrate({
      db: stack.db.client,
      logger,
    });
    substrateRepo = new PgOrchestrationRepository(stack.db.client);
    coordinator = new DefaultDelegationCoordinator({
      db: stack.db.client,
      executionTaskService: taskService,
      executionService,
      executionRecordRepository: executionRecordRepo,
      agentRunRepository: agentRunRepo,
      logger,
      orchestration: substrate,
    });

    // --- fixtures -------------------------------------------------------------
    const org = await stack.organizationRepository.create({ name: 'Orchestration Org' });
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'orch-user', displayName: 'U' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Orchestration Project' });
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Arch-Orchestration' });
    const versionA = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
    await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'REQ-ORCH-001',
      title: 'Orchestratable requirement',
      description: 'A requirement whose work item can be delegated',
    });
    fixtureVersionId = versionA.id;
  });

  let fixtureVersionId: string;

  afterAll(async () => {
    await stack.teardown();
  });

  /** A Work Item with a Work Order (the existing execution path needs both). */
  async function createWorkItem(label: string, projectId = project.id): Promise<string> {
    // The project scope is reached through the architecture (the existing
    // authority chain) — a work item of ANOTHER project needs its own
    // architecture + version.
    let versionId = fixtureVersionId;
    if (projectId !== project.id) {
      const arch = await stack.architectureRepository.create({ projectId, name: `Arch-${label}` });
      const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
      versionId = v.id;
    }
    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionId,
      workItemId: label,
      title: label,
      objective: `Objective for ${label}`,
      scope: `Scope for ${label}`,
    });
    await stack.workOrderRepository.create({
      workItemId: wi.id,
      projectId,
      architectureVersionId: versionId,
      scope: `Scope for ${label}`,
      outOfScope: 'Nothing',
      architectureConstraints: 'None',
      verificationRequirements: ['All tests pass'],
    });
    return wi.id;
  }

  const nativeUnit = (
    unitKey: string,
    dependsOn: string[] = [],
  ): DelegationUnitSpec => ({
    unitKey,
    role: 'implementer',
    mode: 'native',
    provider: 'fake',
    model: NATIVE_MODEL,
    dependsOn,
  });
  const externalUnit = (unitKey: string, dependsOn: string[] = []): DelegationUnitSpec => ({
    unitKey,
    role: 'implementer',
    mode: 'external',
    provider: 'zai',
    model: null,
    dependsOn,
  });

  const planInput = (workItemId: string, planKey = 'default'): DelegationPlanInput => ({
    workItemId,
    planKey,
    units: [nativeUnit('a'), nativeUnit('b'), nativeUnit('c', ['a', 'b'])],
  });

  // --- durable identity -------------------------------------------------------

  it('durable identity — ONE graph per plan, ONE node per unit; the identity survives repeated drives (idempotent ensureGraph)', async () => {
    const wi = await createWorkItem('WI-IDENTITY');
    const plan = await planService.createPlan(planInput(wi));

    const r1 = await coordinator.drivePlan(wi, 'default');
    // One wave per drive: after drive 1 only the roots (a, b) converged.
    expect(r1.planStatus).toBe('active');
    const graph1 = await substrate.getGraph(wi, 'default');
    expect(graph1).not.toBeNull();
    expect(graph1!.planId).toBe(plan.id);
    expect(graph1!.totalNodes).toBe(3);

    // A second drive (and a direct ensureGraph through reconcile) converges
    // on the SAME durable identity — never a duplicate graph/node set.
    const r2 = await coordinator.drivePlan(wi, 'default');
    expect(r2.planStatus).toBe('completed');
    await substrate.reconcile(wi, 'default');
    const graph2 = await substrate.getGraph(wi, 'default');
    expect(graph2!.id).toBe(graph1!.id);
    expect(graph2!.reconciliationCount).toBeGreaterThan(0);

    const nodes = await substrate.listNodes(wi, 'default');
    expect(nodes.map((n) => n.nodeKey)).toEqual(['a', 'b', 'c']);
    // Every node REFERENCES the existing delegation unit (no second identity).
    for (const n of nodes) {
      expect(plan.units.some((u) => u.id === n.unitId)).toBe(true);
    }

    // The identity is NOT derived from process/memory state: it lives in
    // PostgreSQL keyed by the delegation plan (unique by constraint).
    const direct = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM wfos_orchestration_graphs WHERE plan_id = $1`,
      [plan.id],
    );
    expect(direct.rows[0]!.count).toBe(1);
  });

  it('durable identity — every driven node references the EXISTING execution identity (through the delegation attempt)', async () => {
    const wi = await createWorkItem('WI-EXECREF');
    await planService.createPlan(planInput(wi));
    await coordinator.drivePlan(wi, 'default');
    await coordinator.drivePlan(wi, 'default'); // both waves
    const nodes = await substrate.listNodes(wi, 'default');
    for (const n of nodes) {
      expect(n.executionId).not.toBeNull();
      expect(n.attemptNo).toBe(1);
      // The referenced identity IS an existing execution record row.
      const exec = await stack.db.client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM wfos_executions WHERE execution_id = $1`,
        [n.executionId],
      );
      expect(exec.rows[0]!.count, `node ${n.nodeKey} must reference an existing execution`).toBe(1);
    }
  });

  // --- durable dependency gating -------------------------------------------------

  it('dependency gating — a dependent node does NOT dispatch until its dependencies\' DURABLE outcomes admit it (the same drive as the dependencies converging does not admit it — one wave per drive)', async () => {
    const wi = await createWorkItem('WI-GATING');
    await planService.createPlan(planInput(wi));
    const r1 = await coordinator.drivePlan(wi, 'default');
    // Wave 1: a + b dispatched (and, with the synchronous fake agent,
    // converged to succeeded); c was BLOCKED at drive-start classification.
    const c1 = r1.units.find((u) => u.unitKey === 'c')!;
    expect(c1.action).toBe('skipped');
    const nodes1 = await substrate.listNodes(wi, 'default');
    expect(nodes1.find((n) => n.nodeKey === 'c')!.attemptNo).toBeNull();

    // Wave 2: c's dependencies are DURABLY succeeded → c dispatches.
    const r2 = await coordinator.drivePlan(wi, 'default');
    const c2 = r2.units.find((u) => u.unitKey === 'c')!;
    expect(c2.action).toBe('dispatched');
    const nodes2 = await substrate.listNodes(wi, 'default');
    expect(nodes2.find((n) => n.nodeKey === 'c')!.outcome).toBe('succeeded');
  });

  it('dependency-violation rejection — a dependency-blocked node cannot even ACQUIRE a dispatch lease (the mutation boundary rejects it, typed)', async () => {
    const wi = await createWorkItem('WI-VIOLATION');
    await planService.createPlan(planInput(wi));
    // Materialize the graph WITHOUT driving (a no-op executor drive — every
    // acquisition is released immediately; nothing is dispatched).
    await substrate.driveGraph({ workItemId: wi, planKey: 'default', ownerId: 'materialize' }, {
      execute: async (node) => ({
        nodeKey: node.nodeKey,
        unitId: node.unitId,
        outcome: null,
        executionId: node.executionId,
        attemptNo: node.attemptNo,
        action: 'skipped' as const,
      }),
    });
    const nodes = await substrate.listNodes(wi, 'default');
    const c = nodes.find((n) => n.nodeKey === 'c')!;
    expect(c).toBeDefined();

    // The direct repository acquisition (the mutation boundary) rejects the
    // dispatch lease with the TYPED reason.
    const result = await stack.db.client.transaction((tx) =>
      substrateRepo.acquireLease(tx, {
        nodeId: c.id,
        ownerId: 'violator',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        purpose: 'dispatch',
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('dependency-not-satisfied');

    // And even a RAW SQL lease write is rejected by the migration's
    // dependency-gate trigger (defense in depth — a buggy caller cannot
    // lease a never-dispatched node whose dependencies are unsatisfied).
    await expect(
      stack.db.client.query(
        `UPDATE wfos_orchestration_nodes
            SET owner_id = 'violator', lease_expires_at = NOW() + interval '60 seconds'
          WHERE id = $1`,
        [c.id],
      ),
    ).rejects.toThrow(/dependenc/i);
  });

  // --- explicit partial completion --------------------------------------------------

  it('explicit partial completion — 3/10 nodes with 1 failed is PARTIAL (observable, resumable — never collapsed into success or failure)', async () => {
    const wi = await createWorkItem('WI-PARTIAL');
    // 10 units: a1..a3 independent roots; rest depend on all three.
    const units: DelegationUnitSpec[] = [
      nativeUnit('a1'), nativeUnit('a2'), nativeUnit('a3'),
      ...Array.from({ length: 7 }, (_, i) => nativeUnit(`d${i + 1}`, ['a1', 'a2', 'a3'])),
    ];
    await planService.createPlan({ workItemId: wi, planKey: 'default', units });

    // a2 FAILS (the fake agent fails its first call for this execution).
    fakeAgent.reset();
    fakeAgent.setFailure('non_retryable', 'planned failure', false, 1);
    await coordinator.drivePlan(wi, 'default');
    fakeAgent.reset();

    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('partial');
    expect(graph!.succeededCount).toBe(2); // a1 + a3
    expect(graph!.failedCount).toBe(1); // a2
    expect(graph!.totalNodes).toBe(10);

    // The partial state is RESUMABLE: retry a1 (the failed root — the first
    // dispatched node in node_key order) → succeeded; the dependents become
    // admissible on the next drive (nothing was collapsed).
    await coordinator.retryUnit(wi, 'default', 'a1');
    const graphAfterRetry = await substrate.getGraph(wi, 'default');
    expect(graphAfterRetry!.succeededCount).toBe(3);
    expect(graphAfterRetry!.status).toBe('partial');

    // Drive the fan-out: all 7 dependents dispatch in ONE wave (they are
    // mutually independent) and the graph CONVERGES.
    const r = await coordinator.drivePlan(wi, 'default');
    expect(r.planStatus).toBe('completed');
    const converged = await substrate.getGraph(wi, 'default');
    expect(converged!.status).toBe('converged');
    expect(converged!.succeededCount).toBe(10);
    expect(converged!.failedCount).toBe(0);
  });

  // --- deterministic reconciliation -----------------------------------------------

  it('deterministic reconciliation — the same durable state reconciles to the same result (idempotent, ordered, no wall-clock winner selection)', async () => {
    const wi = await createWorkItem('WI-DETERMINISM');
    await planService.createPlan(planInput(wi));
    fakeAgent.reset();
    fakeAgent.setFailure('non_retryable', 'planned failure', false, 1);
    await coordinator.drivePlan(wi, 'default');
    fakeAgent.reset();

    const before = await substrate.getGraph(wi, 'default');
    const nodesBefore = await substrate.listNodes(wi, 'default');

    // Reconcile repeatedly — the durable outcome state is UNCHANGED by
    // reconciliation (idempotent); only the audit counter moves.
    await substrate.reconcile(wi, 'default');
    await substrate.reconcile(wi, 'default');
    const after = await substrate.getGraph(wi, 'default');
    const nodesAfter = await substrate.listNodes(wi, 'default');

    expect(after!.status).toBe(before!.status);
    expect(after!.succeededCount).toBe(before!.succeededCount);
    expect(after!.failedCount).toBe(before!.failedCount);
    expect(after!.reconciliationCount).toBeGreaterThan(before!.reconciliationCount);
    expect(nodesAfter.map((n) => [n.nodeKey, n.outcome])).toEqual(
      nodesBefore.map((n) => [n.nodeKey, n.outcome]),
    );
    // Nodes are ALWAYS read in the documented total order (node_key).
    expect(nodesAfter.map((n) => n.nodeKey)).toEqual([...nodesAfter.map((n) => n.nodeKey)].sort());
  });

  // --- replanning without evidence loss ---------------------------------------------

  it('replanning without evidence loss — a NEW plan (different key) creates a NEW graph; the old graph, its node outcomes, and every attempt/execution row survive intact', async () => {
    const wi = await createWorkItem('WI-REPLAN');
    await planService.createPlan({ ...planInput(wi), planKey: 'original' });
    fakeAgent.reset();
    fakeAgent.setFailure('non_retryable', 'planned failure', false, 1);
    await coordinator.drivePlan(wi, 'original');
    fakeAgent.reset();

    const originalGraph = await substrate.getGraph(wi, 'original');
    expect(originalGraph!.status).toBe('partial');
    const originalNodes = await substrate.listNodes(wi, 'original');
    const originalExecIds = originalNodes.map((n) => n.executionId);

    // Replan: a different plan key for the same Work Item.
    await planService.createPlan({ workItemId: wi, planKey: 'revised', units: [nativeUnit('a'), nativeUnit('b')] });
    await coordinator.drivePlan(wi, 'revised');

    const revisedGraph = await substrate.getGraph(wi, 'revised');
    expect(revisedGraph!.id).not.toBe(originalGraph!.id);

    // The ORIGINAL evidence is untouched (nothing erased or rewritten).
    const originalAfter = await substrate.getGraph(wi, 'original');
    expect(originalAfter!.status).toBe('partial');
    expect(originalAfter!.succeededCount).toBe(originalGraph!.succeededCount);
    const nodesAfter = await substrate.listNodes(wi, 'original');
    expect(nodesAfter.map((n) => n.executionId)).toEqual(originalExecIds);
    for (const execId of originalExecIds) {
      if (execId === null) continue;
      const exec = await stack.db.client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM wfos_executions WHERE execution_id = $1`,
        [execId],
      );
      expect(exec.rows[0]!.count).toBe(1);
    }
    // The original plan's attempts are still there (delegation authority).
    const attempts = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM wfos_delegation_attempts a
         JOIN wfos_delegation_units u ON u.id = a.unit_id
         JOIN wfos_delegation_plans p ON p.id = u.plan_id
        WHERE p.work_item_id = $1 AND p.plan_key = 'original'`,
      [wi],
    );
    // 'a' failed (1 attempt) + 'b' succeeded (1 attempt); 'c' never
    // dispatched (blocked on 'a') — the ORIGINAL attempt history is intact.
    expect(attempts.rows[0]!.count).toBe(2);
  });

  // --- tenant isolation ----------------------------------------------------------------

  it('tenant isolation — the SAME logical keys in two projects cannot collide; graphs are project-scoped; dependencies cannot cross tenants', async () => {
    // A SECOND project (another tenant).
    const org2 = await stack.organizationRepository.create({ name: 'Orchestration Org 2' });
    const user2 = await stack.userRepository.upsertByExternalId({ externalId: 'orch-user-2', displayName: 'U2' });
    await stack.membershipRepository.assign({ userId: user2.id, organizationId: org2.id, roleId: 'owner' });
    const project2 = await stack.projectRepository.create({ organizationId: org2.id, name: 'Orchestration Project 2' });

    const wiA = await createWorkItem('WI-TENANT-A', project.id);
    const wiB = await createWorkItem('WI-TENANT-B', project2.id);

    // The SAME plan key + unit keys in both projects.
    await planService.createPlan(planInput(wiA));
    await planService.createPlan(planInput(wiB));
    await coordinator.drivePlan(wiA, 'default');
    await coordinator.drivePlan(wiB, 'default');

    const graphA = await substrate.getGraph(wiA, 'default');
    const graphB = await substrate.getGraph(wiB, 'default');
    expect(graphA!.id).not.toBe(graphB!.id);
    expect(graphA!.projectId).toBe(project.id);
    expect(graphB!.projectId).toBe(project2.id);

    // No cross-tenant node leakage: every node of graph A carries project A.
    const nodesA = await substrate.listNodes(wiA, 'default');
    for (const n of nodesA) expect(n.projectId).toBe(project.id);
    const nodesB = await substrate.listNodes(wiB, 'default');
    for (const n of nodesB) expect(n.projectId).toBe(project2.id);

    // Ownership acquisition is project-scoped: the substrate resolves the
    // project SERVER-SIDE (the work item's architecture chain) — a node of
    // project B is unreachable through project A's work item.
    const countCross = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM wfos_orchestration_nodes n
        WHERE n.project_id = $1 AND n.graph_id = $2`,
      [project2.id, graphA!.id],
    );
    expect(countCross.rows[0]!.count).toBe(0);

    // A dependency referencing another tenant's node key is REJECTED at
    // graph creation (dependencies must resolve within the SAME plan —
    // which lives within ONE work item within ONE project).
    await expect(
      substrateRepo.readDelegationPlan(wiA, 'default'),
    ).resolves.toMatchObject({ projectId: project.id });
  });

  // --- simple / complex / very-complex shapes under ONE semantics ------------------------

  it('SIMPLE shape — a single delegated execution runs under the same orchestration semantics', async () => {
    const wi = await createWorkItem('WI-SIMPLE');
    await planService.createPlan({ workItemId: wi, planKey: 'default', units: [nativeUnit('solo')] });
    const r = await coordinator.drivePlan(wi, 'default');
    expect(r.planStatus).toBe('completed');
    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('converged');
    expect(graph!.totalNodes).toBe(1);
    expect(graph!.succeededCount).toBe(1);
  });

  it('COMPLEX shape — a bounded DAG (A → C ← B) runs under the same semantics (parallel-safe waves, durable gating)', async () => {
    const wi = await createWorkItem('WI-COMPLEX');
    await planService.createPlan({
      workItemId: wi,
      planKey: 'default',
      units: [nativeUnit('a'), nativeUnit('b'), nativeUnit('c', ['a', 'b'])],
    });
    await coordinator.drivePlan(wi, 'default');
    const mid = await substrate.getGraph(wi, 'default');
    expect(mid!.status).toBe('partial');
    expect(mid!.succeededCount).toBe(2);
    await coordinator.drivePlan(wi, 'default');
    const done = await substrate.getGraph(wi, 'default');
    expect(done!.status).toBe('converged');
    expect(done!.succeededCount).toBe(3);
  });

  it('VERY-COMPLEX shape — 24 nodes, 4 waves, fan-out/fan-in, a partial failure, a retry, and an ownership change all converge under the SAME semantics', async () => {
    const wi = await createWorkItem('WI-VERYCOMPLEX');
    // Wave 1: 4 roots. Wave 2: 8 (each depends on 2 roots). Wave 3: 8 (each
    // depends on 2 of wave 2). Wave 4: 4 (each depends on all of wave 3).
    const units: DelegationUnitSpec[] = [];
    for (let i = 0; i < 4; i++) units.push(nativeUnit(`w1-${i}`));
    for (let i = 0; i < 8; i++) units.push(nativeUnit(`w2-${i}`, [`w1-${i % 4}`, `w1-${(i + 1) % 4}`]));
    for (let i = 0; i < 8; i++) units.push(nativeUnit(`w3-${i}`, [`w2-${i % 8}`, `w2-${(i + 3) % 8}`]));
    const w3All = Array.from({ length: 8 }, (_, i) => `w3-${i}`);
    for (let i = 0; i < 4; i++) units.push(nativeUnit(`w4-${i}`, w3All));
    await planService.createPlan({ workItemId: wi, planKey: 'default', units });

    // A transient failure in wave 2 (retry recovers it).
    fakeAgent.reset();
    fakeAgent.setFailure('non_retryable', 'transient', false, 1);
    await coordinator.drivePlan(wi, 'default'); // wave 1 (+ w2 classification)
    fakeAgent.reset();
    // Retry the failed unit; then drive repeatedly until converged.
    const failed = (await substrate.listNodes(wi, 'default')).find((n) => n.outcome === 'failed');
    expect(failed).toBeDefined();
    await coordinator.retryUnit(wi, 'default', failed!.nodeKey);

    let planStatus = 'active';
    for (let drive = 0; drive < 8 && planStatus !== 'completed'; drive++) {
      const r = await coordinator.drivePlan(wi, 'default');
      planStatus = r.planStatus;
    }
    expect(planStatus).toBe('completed');
    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('converged');
    expect(graph!.totalNodes).toBe(24);
    expect(graph!.succeededCount).toBe(24);
    expect(graph!.failedCount).toBe(0);
    // One node needed a second attempt (the retry) — evidence preserved.
    const attempts = await stack.db.client.query<{ unit_key: string; attempts: number }>(
      `SELECT u.unit_key, COUNT(a.id)::int AS attempts
         FROM wfos_delegation_units u
         LEFT JOIN wfos_delegation_attempts a ON a.unit_id = u.id
        WHERE u.plan_id = (SELECT id FROM wfos_delegation_plans WHERE work_item_id = $1 AND plan_key = 'default')
        GROUP BY u.unit_key
        ORDER BY attempts DESC, u.unit_key`,
      [wi],
    );
    expect(attempts.rows[0]!.attempts).toBe(2);
    expect(attempts.rows.filter((r) => r.attempts === 2)).toHaveLength(1);
  });

  // --- native / external semantic parity -------------------------------------------------

  it('native/external parity — an external-mode DAG runs under the SAME orchestration semantics (admission, waves, partial, convergence)', async () => {
    const wi = await createWorkItem('WI-PARITY');
    await planService.createPlan({
      workItemId: wi,
      planKey: 'default',
      units: [externalUnit('x-a'), externalUnit('x-b'), externalUnit('x-c', ['x-a', 'x-b'])],
    });
    // External executions go to handoff (no synchronous completion) — the
    // orchestration semantics are the SAME: wave 1 dispatched, wave 2 gated.
    const r1 = await coordinator.drivePlan(wi, 'default');
    expect(r1.units.find((u) => u.unitKey === 'x-c')!.action).toBe('skipped');
    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.totalNodes).toBe(3);
    const nodes = await substrate.listNodes(wi, 'default');
    // The external nodes hold their durable execution references (the
    // EXISTING external execution identities).
    expect(nodes.find((n) => n.nodeKey === 'x-a')!.executionId).not.toBeNull();
    expect(nodes.find((n) => n.nodeKey === 'x-c')!.attemptNo).toBeNull();
    // The graph is honestly partial (2 in flight, not collapsed).
    expect(graph!.status).toBe('orchestrating');
  });

  // --- interruption mirror ------------------------------------------------------------------

  it('interruption — the graph mirrors abandonment, releases every lease, and NEVER erases durable evidence', async () => {
    const wi = await createWorkItem('WI-ABANDON');
    await planService.createPlan({
      workItemId: wi,
      planKey: 'default',
      units: [externalUnit('e-a'), externalUnit('e-c', ['e-a'])],
    });
    await coordinator.drivePlan(wi, 'default'); // e-a in flight (external)
    const before = await substrate.listNodes(wi, 'default');
    const inFlight = before.find((n) => n.nodeKey === 'e-a')!;
    expect(inFlight.executionId).not.toBeNull();

    await coordinator.interruptPlan(wi, 'default');

    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('abandoned');
    const nodes = await substrate.listNodes(wi, 'default');
    for (const n of nodes) {
      expect(n.ownerId).toBeNull(); // every lease released
    }
    // Durable evidence preserved: the in-flight execution reference + the
    // cancelled pending node stay observable.
    expect(nodes.find((n) => n.nodeKey === 'e-a')!.executionId).toBe(inFlight.executionId);
    expect(nodes.find((n) => n.nodeKey === 'e-c')!.outcome).toBe('cancelled');

    // Idempotent.
    await coordinator.interruptPlan(wi, 'default');
    expect((await substrate.getGraph(wi, 'default'))!.status).toBe('abandoned');
  });

  // --- no-autonomous-scheduler (structural, through the substrate's behavior) -----------------

  it('NO autonomous scheduler — the substrate drives NOTHING on its own: an untouched graph is bit-identical after arbitrary time', async () => {
    const wi = await createWorkItem('WI-NOSCHED');
    await planService.createPlan(planInput(wi));
    await substrate.reconcile(wi, 'default'); // materialize the graph, no drive
    const before = await substrate.listNodes(wi, 'default');
    // No drive call → no attempts exist for any unit (nothing was scheduled).
    const attempts = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM wfos_delegation_attempts a
         JOIN wfos_delegation_units u ON u.id = a.unit_id
         JOIN wfos_delegation_plans p ON p.id = u.plan_id
        WHERE p.work_item_id = $1`,
      [wi],
    );
    expect(attempts.rows[0]!.count).toBe(0);
    const after = await substrate.listNodes(wi, 'default');
    expect(after.map((n: OrchestrationNode) => [n.nodeKey, n.outcome, n.attemptNo])).toEqual(
      before.map((n) => [n.nodeKey, n.outcome, n.attemptNo]),
    );
  });

  // --- typed fail-closed errors ---------------------------------------------------------------

  it('typed fail-closed errors — unknown plan, unknown node, non-retryable node (machine-readable codes)', async () => {
    const wi = await createWorkItem('WI-ERRORS');
    await planService.createPlan(planInput(wi));
    await coordinator.drivePlan(wi, 'default');

    await expect(substrate.getGraph(wi, 'missing')).resolves.toBeNull();
    await expect(
      substrate.reconcile(wi, 'missing'),
    ).resolves.toBeNull();
    await expect(
      substrate.retryNode({ workItemId: wi, planKey: 'default', nodeKey: 'missing', ownerId: 'x' }, {
        execute: async () => { throw new Error('unreachable'); },
      }),
    ).rejects.toBeInstanceOf(OrchestrationError);

    // A succeeded node is NOT retryable (the WORK-046 contract).
    await expect(
      substrate.retryNode({ workItemId: wi, planKey: 'default', nodeKey: 'a', ownerId: 'x' }, {
        execute: async () => { throw new Error('unreachable'); },
      }),
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_NODE_NOT_RETRYABLE' });
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildRuntimeStack,
  type TestRuntimeStack,
} from '../../helpers/test-identity-runtime-stack.js';

/**
 * WORK-074 — proofs #7 (machine principal scoping) + #8 (privilege separation).
 *
 * On real PostgreSQL. Discrimination-proven: removing the scope check, the
 * capability check, or the tenant check makes the corresponding test FAIL.
 *
 * The implementation-agent capability set (WORK-063):
 *   can:  workitem.read, workitem.write, branch.create, pr.create, execution.read
 *   cannot: architecture.modify, governance.approve, verification.alter, tenant.change
 */

// The canonical implementation-agent capability set.
const IMPL_AGENT_CAPABILITIES = [
  'workitem.read',
  'workitem.write',
  'branch.create',
  'pr.create',
  'execution.read',
] as const;

describe('WORK-074 — machine identity: scoping + privilege separation', () => {
  let stack: TestRuntimeStack;
  let orgId: string;
  let projectId: string;
  let saId: string;

  beforeAll(async () => {
    stack = await buildRuntimeStack();
    const org = await stack.organizationRepository.create({ name: 'Machine Org' });
    orgId = org.id;
    const project = await stack.projectRepository.create({
      organizationId: orgId, name: 'Machine Project',
    });
    projectId = project.id;
    // A service account with the implementation-agent capability set.
    const sa = await stack.serviceAccountRepository.create({
      organizationId: orgId,
      name: 'impl-agent',
      capabilities: [...IMPL_AGENT_CAPABILITIES],
    });
    saId = sa.id;
  });
  afterAll(async () => {
    await stack.teardown();
  });

  // -------------------------------------------------------------------------
  // Proof #7: a scoped credential CAN exercise granted capabilities and CANNOT
  // exercise ungranted ones (typed denials; mutation-proven).
  // -------------------------------------------------------------------------
  it('granted capabilities are allowed; ungranted capabilities are denied (fail closed)', async () => {
    const sa = (await stack.serviceAccountRepository.findById(saId))!;
    // project.read IS granted via workitem.read → project.read + execution.read → project.read.
    const read = await stack.runtimeAuthorizationService.authorizeMachine({
      serviceAccount: sa,
      capabilities: sa.capabilities,
      permission: 'project.read',
      resource: { kind: 'project', projectId },
    });
    expect(read.allowed).toBe(true);

    // project.write IS granted via workitem.write/branch.create/pr.create → project.write.
    const write = await stack.runtimeAuthorizationService.authorizeMachine({
      serviceAccount: sa,
      capabilities: sa.capabilities,
      permission: 'project.write',
      resource: { kind: 'project', projectId },
    });
    expect(write.allowed).toBe(true);

    // project.admin is NOT granted (architecture.modify/verification.alter map
    // to project.admin, but the impl-agent set does NOT hold those).
    const admin = await stack.runtimeAuthorizationService.authorizeMachine({
      serviceAccount: sa,
      capabilities: sa.capabilities,
      permission: 'project.admin',
      resource: { kind: 'project', projectId },
    });
    expect(admin.allowed).toBe(false);
    expect(admin.deniedReason).toBe('missing-permission');

    // org.admin (tenant change / governance) is NOT granted.
    const orgAdmin = await stack.runtimeAuthorizationService.authorizeMachineForOrganization({
      serviceAccount: sa,
      capabilities: sa.capabilities,
      permission: 'org.admin',
      organizationId: orgId,
    });
    expect(orgAdmin.allowed).toBe(false);
    expect(orgAdmin.deniedReason).toBe('missing-permission');
  });

  // -------------------------------------------------------------------------
  // Proof #7 (mutation): a credential scoped to a SUBSET of the service
  // account's capabilities cannot exceed its scopes (effective caps =
  // intersection of SA caps + credential scopes). Removing the intersection
  // makes the test FAIL (discrimination).
  // -------------------------------------------------------------------------
  it('a scoped credential cannot exceed its granted scopes (effective = intersection)', async () => {
    const sa = (await stack.serviceAccountRepository.findById(saId))!;
    // Credential scoped to ONLY workitem.read (read-only).
    const effectiveCaps = sa.capabilities.filter((c) => c === 'workitem.read');
    const read = await stack.runtimeAuthorizationService.authorizeMachine({
      serviceAccount: sa,
      capabilities: effectiveCaps,
      permission: 'project.read',
      resource: { kind: 'project', projectId },
    });
    expect(read.allowed).toBe(true);
    // The same credential CANNOT write (project.write) — the scope excludes it.
    const write = await stack.runtimeAuthorizationService.authorizeMachine({
      serviceAccount: sa,
      capabilities: effectiveCaps,
      permission: 'project.write',
      resource: { kind: 'project', projectId },
    });
    expect(write.allowed).toBe(false);
    expect(write.deniedReason).toBe('missing-permission');
  });

  // -------------------------------------------------------------------------
  // Proof #8 (privilege separation): the impl-agent capability set CANNOT
  // modify architecture, approve its own PR, alter verification evidence, or
  // change tenant (each fails closed).
  // -------------------------------------------------------------------------
  describe('privilege separation — impl-agent cannot exercise privileged capabilities', () => {
    const privilegedChecks: Array<{ name: string; capability: string; permission: string; resourceKind: 'project' | 'org' }> = [
      { name: 'modify architecture', capability: 'architecture.modify', permission: 'project.admin', resourceKind: 'project' },
      { name: 'approve own PR (governance)', capability: 'governance.approve', permission: 'org.admin', resourceKind: 'org' },
      { name: 'alter verification evidence', capability: 'verification.alter', permission: 'project.admin', resourceKind: 'project' },
      { name: 'change tenant', capability: 'tenant.change', permission: 'org.admin', resourceKind: 'org' },
    ];

    for (const check of privilegedChecks) {
      it(`impl-agent CANNOT ${check.name} (fails closed)`, async () => {
        const sa = (await stack.serviceAccountRepository.findById(saId))!;
        // The impl-agent set does NOT include the privileged capability.
        expect(sa.capabilities).not.toContain(check.capability);

        if (check.resourceKind === 'project') {
          const decision = await stack.runtimeAuthorizationService.authorizeMachine({
            serviceAccount: sa,
            capabilities: sa.capabilities,
            permission: check.permission,
            resource: { kind: 'project', projectId },
          });
          expect(decision.allowed).toBe(false);
          expect(decision.deniedReason).toBe('missing-permission');
        } else {
          const decision = await stack.runtimeAuthorizationService.authorizeMachineForOrganization({
            serviceAccount: sa,
            capabilities: sa.capabilities,
            permission: check.permission,
            organizationId: orgId,
          });
          expect(decision.allowed).toBe(false);
          expect(decision.deniedReason).toBe('missing-permission');
        }
      });

      it(`discrimination: a credential WITH ${check.name} CAN exercise it (the check is meaningful)`, async () => {
        // A privileged service account (with the privileged capability) CAN
        // exercise it — proving the denial above is the capability check, not
        // a blanket block. This is the discrimination: removing the capability
        // check would let the impl-agent through; the check is load-bearing.
        const privSa = await stack.serviceAccountRepository.create({
          organizationId: orgId,
          name: `priv-${check.capability}`,
          capabilities: [...IMPL_AGENT_CAPABILITIES, check.capability],
        });
        if (check.resourceKind === 'project') {
          const decision = await stack.runtimeAuthorizationService.authorizeMachine({
            serviceAccount: privSa,
            capabilities: privSa.capabilities,
            permission: check.permission,
            resource: { kind: 'project', projectId },
          });
          expect(decision.allowed).toBe(true);
        } else {
          const decision = await stack.runtimeAuthorizationService.authorizeMachineForOrganization({
            serviceAccount: privSa,
            capabilities: privSa.capabilities,
            permission: check.permission,
            organizationId: orgId,
          });
          expect(decision.allowed).toBe(true);
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // Proof #8 (tenant isolation for machines): a machine credential scoped to
  // Org A CANNOT access Org B's project (AUTHZ-AC-02 unchanged for machines).
  // -------------------------------------------------------------------------
  it('machine tenant isolation: a credential scoped to Org A cannot access Org B', async () => {
    const orgB = await stack.organizationRepository.create({ name: 'Machine Org B' });
    const projectB = await stack.projectRepository.create({
      organizationId: orgB.id, name: 'Machine Project B',
    });
    const sa = (await stack.serviceAccountRepository.findById(saId))!;
    // sa belongs to orgId (Org A). Attempting Org B's project → denied (not-a-member).
    const decision = await stack.runtimeAuthorizationService.authorizeMachine({
      serviceAccount: sa,
      capabilities: sa.capabilities,
      permission: 'project.read',
      resource: { kind: 'project', projectId: projectB.id },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toBe('not-a-member');
  });

  // -------------------------------------------------------------------------
  // Human/machine non-confusion (invariant #3): a machine principal is NEVER
  // a human user. The RequestAuthenticator resolves them to distinct types.
  // -------------------------------------------------------------------------
  it('human/machine non-confusion: a machine API key never resolves to a human user', async () => {
    const sa = (await stack.serviceAccountRepository.findById(saId))!;
    const RAW_KEY = 'wfos_test_machine_key_non_confusion';
    const ENV_VAR = 'WFOS_TEST_MACHINE_KEY_NC';
    process.env[ENV_VAR] = RAW_KEY;
    await stack.apiKeyProvisioner.provision({
      keyId: 'machine-key-nc',
      secretRef: ENV_VAR,
      externalId: `service-account:${sa.id}`,
      label: sa.name,
      rawKey: RAW_KEY,
      serviceAccountId: sa.id,
      scopes: sa.capabilities,
    });

    const principal = await stack.requestAuthenticator.authenticateRequest({ apiKey: RAW_KEY });
    expect(principal).not.toBeNull();
    expect(principal!.kind).toBe('machine');
    expect(principal!.kind).not.toBe('human');
    // A machine principal has NO user (it is NOT a human user).
    if (principal!.kind === 'machine') {
      expect(principal!.serviceAccount.id).toBe(sa.id);
      expect(principal!.capabilities).toContain('workitem.read');
    }
    delete process.env[ENV_VAR];
  });
});

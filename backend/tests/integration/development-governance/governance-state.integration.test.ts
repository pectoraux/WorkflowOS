import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DefaultDevelopmentGovernanceService,
  FileSystemGovernanceStateLoader,
  GovernanceStateValidationError,
  NoResumableStateError,
  UnknownWorkOrderError,
} from '../../../src/development-governance/index.js';
import type { GovernanceModel, ProgramState } from '../../../src/development-governance/index.js';

/**
 * WORK-052 — the repository-resident development-governance control plane.
 *
 * This suite is the FRESH-CHECKOUT PROOF (W052-AC01) plus the fail-closed
 * validation/discrimination proofs (W052-AC02) and the crash/restart/resume
 * proof (W052-AC07): every assertion runs against the REAL repository
 * artifacts at `spec/development-state/` — the same state a brand-new
 * implementer clones — never against mocks of them.
 */
describe('WORK-052 — repository source of truth (fresh-checkout reconstruction + fail-closed validation)', () => {
  // backend/tests/integration/development-governance/ → the repository root.
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const GOVERNANCE_DIR = join(REPO_ROOT, 'spec', 'development-state');

  let realModel: GovernanceModel;
  let realProgram: ProgramState;
  let service: DefaultDevelopmentGovernanceService;

  beforeAll(async () => {
    const loaded = await new FileSystemGovernanceStateLoader({
      repoRoot: REPO_ROOT,
      governanceDir: GOVERNANCE_DIR,
    }).load();
    realModel = loaded.model;
    realProgram = loaded.program;
    service = DefaultDevelopmentGovernanceService.fromLoadedState(realModel, realProgram);
  });

  // --- W052-AC01: fresh-checkout reconstruction (the seven control questions) --

  it('W052-AC01 — a fresh checkout reconstructs the architecture program (the seven control questions, zero conversational history)', async () => {
    // A FRESH service instance from the repository root only — this is what a
    // brand-new implementer constructs after cloning.
    const fresh = await DefaultDevelopmentGovernanceService.create({ repoRoot: REPO_ROOT });

    // Q1 — what architecture version governs?
    const governing = fresh.getGoverningState();
    expect(governing.architectureVersion).toBe('v1.0');
    expect(governing.architectureVersionState).toBe('frozen');
    expect(governing.evolution).toMatch(/§34/);
    expect(governing.controlLoop.map((s) => s.name)).toEqual([
      'sense', 'understand', 'plan', 'check', 'execute', 'verify', 'review', 'release', 'observe', 'learn',
    ]);

    // Q2 — which Work Orders exist?
    const all = fresh.listWorkOrders();
    expect(all.length).toBeGreaterThanOrEqual(52);
    expect(all.map((w) => w.id)).toContain('WORK-051');
    expect(all.map((w) => w.id)).toContain('WORK-052');

    // Q3 — which are complete / in flight / blocked?
    const complete = fresh.listWorkOrders({ status: 'complete' });
    const inFlight = fresh.listWorkOrders({ status: 'in_flight' });
    expect(complete.length).toBeGreaterThanOrEqual(45);
    expect(inFlight.map((w) => w.id).sort()).toEqual(['WORK-046', 'WORK-051', 'WORK-052']);
    // Every completed item carries merge evidence (the truthful record).
    for (const w of complete) {
      expect(w.mergedAs?.pr, `${w.id} must record its merge PR`).toBeGreaterThan(0);
      expect(w.mergedAs?.mergeCommit).toMatch(/^[0-9a-f]{7,40}$/i);
    }

    // Q4 — what can safely run in parallel? (frontier + conflicts)
    const frontier = fresh.getFrontier();
    expect(frontier.inFlight.length).toBe(3);
    // WORK-048's dependencies (040/041/042/044) are all complete → the frontier.
    expect(frontier.dependencyEligible.map((w) => w.id)).toContain('WORK-048');
    // WORK-047 is blocked on the in-flight WORK-046.
    const w047 = frontier.blocked.find((w) => w.id === 'WORK-047');
    expect(w047?.blockedBy).toContain('WORK-046');
    // The KNOWN real-world conflict is reported: WORK-046 and WORK-051 share
    // the static-architecture suite + the composition root.
    const w051Conflicts = frontier.inFlight.find((w) => w.id === 'WORK-051')?.conflicts ?? [];
    const with046 = w051Conflicts.find((c) => c.with === 'WORK-046');
    expect(with046, 'WORK-051 ↔ WORK-046 shared surfaces are reported').toBeTruthy();
    expect(with046?.sharedSurfaces.some((s) => s.value.includes('static-architecture.test.ts'))).toBe(true);
    expect(with046?.coordinated, 'the conflict is documented as coordinated').toBe(true);

    // Q5 — which checkpoints apply, at which assurance depth?
    const assurance = fresh.resolveAssurance('WORK-052');
    expect(assurance.profile).toBe('CRITICAL');
    expect(assurance.requiredProofClasses).toEqual(['static', 'dynamic', 'discrimination']);
    expect(assurance.architectReviewRecord).toBe(true);
    expect(assurance.applicableContracts.length).toBe(11);
    const light = fresh.getCheckpointApplicability('LIGHT');
    expect(light.length).toBeGreaterThan(0);
    expect(light.length).toBeLessThan(assurance.applicableContracts.length);

    // Q6 — which decisions constrain the work?
    expect(governing.decisions.map((d) => d.id)).toContain('ADR-0001');
    expect(governing.decisions.filter((d) => d.kind === 'adr').length).toBeGreaterThanOrEqual(6);

    // Q7 — how do I resume interrupted implementation? (WORK-052 has a handoff)
    const resumption = fresh.resumeImplementation('WORK-052');
    expect(resumption.branch).toBe('feat/work-052-development-governance');
    expect(resumption.handoff.lastVerifiedState.length).toBeGreaterThan(0);
    expect(resumption.handoff.nextSteps.length).toBeGreaterThan(0);
  });

  it('W052-AC01 — the governance:status CLI entry answers from the repository alone (the script exists and constructs the service)', async () => {
    // The CLI is exercised end-to-end in CI; here we pin its existence and
    // that it wires the service rather than independent state.
    const cliPath = join(REPO_ROOT, 'backend', 'src', 'development-governance', 'cli.ts');
    const { readFile } = await import('node:fs/promises');
    const cli = await readFile(cliPath, 'utf8');
    expect(cli).toMatch(/DefaultDevelopmentGovernanceService\.create/);
    expect(cli).toMatch(/getFrontier/);
  });

  // --- W052-AC02: fail-closed validation + discrimination ----------------------

  /**
   * Writes mutated copies of the REAL artifacts into a temp governance dir and
   * inspects them against the REAL repository root (enforcement references
   * resolve against the real tree; only the mutated artifact differs).
   */
  const inspectMutated = async (
    mutateModel?: (m: GovernanceModel) => void,
    mutateProgram?: (p: ProgramState) => void,
  ): Promise<string[]> => {
    const dir = mkdtempSync(join(tmpdir(), 'wfos-gov-discrimination-'));
    try {
      const model: GovernanceModel = structuredClone(realModel);
      const program: ProgramState = structuredClone(realProgram);
      mutateModel?.(model);
      mutateProgram?.(program);
      writeFileSync(join(dir, 'governance-model.json'), JSON.stringify(model, null, 2));
      writeFileSync(join(dir, 'program-state.json'), JSON.stringify(program, null, 2));
      const loaded = await new FileSystemGovernanceStateLoader({
        repoRoot: REPO_ROOT,
        governanceDir: dir,
      }).inspect();
      return loaded.validation.violations;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('W052-AC02 — the BASELINE validates: zero violations against the real repository (the control plane serves the real state)', async () => {
    const loaded = await new FileSystemGovernanceStateLoader({
      repoRoot: REPO_ROOT,
      governanceDir: GOVERNANCE_DIR,
    }).inspect();
    expect(loaded.validation.violations, loaded.validation.violations.join('\n')).toEqual([]);
    expect(loaded.validation.ok).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: a weakened self-hosting boundary (removed core prohibition) is REJECTED', async () => {
    const violations = await inspectMutated((m) => {
      m.selfHostingBoundary.coreProhibitions = m.selfHostingBoundary.coreProhibitions.slice(1);
      m.selfHostingBoundary.mayNot = m.selfHostingBoundary.mayNot.filter(
        (x) => x !== m.selfHostingBoundary.coreProhibitions[0],
      );
    });
    expect(violations.some((v) => v.includes('core prohibition REMOVED'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: a cyclic dependency DAG is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      // WORK-052 → WORK-051 already exists; add WORK-051 → WORK-052 to close a cycle.
      const w051 = p.workOrders.find((w) => w.id === 'WORK-051')!;
      w051.dependencies = [...w051.dependencies, 'WORK-052'];
    });
    expect(violations.some((v) => v.includes('CYCLE'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: a completion without merge evidence is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      const w046 = p.workOrders.find((w) => w.id === 'WORK-046')!;
      w046.status = 'complete';
      delete (w046 as { mergedAs?: unknown }).mergedAs;
    });
    expect(violations.some((v) => v.includes('REQUIRES merge evidence'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: a weakened CRITICAL assurance matrix is REJECTED', async () => {
    const violations = await inspectMutated((m) => {
      m.assuranceProfiles.requirements.CRITICAL!.proofClasses = ['static'];
      m.assuranceProfiles.requirements.CRITICAL!.architectReviewRecord = false;
      m.assuranceProfiles.requirements.CRITICAL!.checkpointKinds = ['pr_conformance'];
    });
    expect(violations.some((v) => v.includes('code-pinned minimum was weakened'))).toBe(true);
    // Dominance also fails: pr_conformance-only no longer covers readiness at high impact.
    expect(violations.some((v) => v.includes('dominance'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: an enforcement reference to a missing file is REJECTED', async () => {
    const violations = await inspectMutated((m) => {
      m.checkpointContracts[0]!.enforcement[0]!.file = 'backend/tests/does-not-exist.test.ts';
    });
    expect(violations.some((v) => v.includes('referenced file does not exist'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: schema drift (unknown field) is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      (p as unknown as Record<string, unknown>).chatContext = 'allowed';
    });
    expect(violations.some((v) => v.includes('unknown field "chatContext"'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: an assurance profile inconsistent with the deterministic selection is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      // WORK-052 declares authorityBoundary surfaces; lie about the profile.
      const w052 = p.workOrders.find((w) => w.id === 'WORK-052')!;
      w052.assuranceProfile = 'LIGHT';
    });
    expect(violations.some((v) => v.includes('does not match the DETERMINISTIC selection'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: an uncoordinated in-flight start over incomplete dependencies is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      const w052 = p.workOrders.find((w) => w.id === 'WORK-052')!;
      delete (w052 as { coordination?: unknown }).coordination;
    });
    expect(violations.some((v) => v.includes('REQUIRES an explicit coordination record'))).toBe(true);
  });

  it('W052-AC02 — the loader REFUSES to serve an invalid state (GovernanceStateValidationError, fail closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfos-gov-invalid-'));
    try {
      const model: GovernanceModel = structuredClone(realModel);
      model.selfHostingBoundary.coreProhibitions = [];
      model.selfHostingBoundary.mayNot = [];
      writeFileSync(join(dir, 'governance-model.json'), JSON.stringify(model));
      writeFileSync(join(dir, 'program-state.json'), JSON.stringify(realProgram));
      await expect(
        DefaultDevelopmentGovernanceService.create({ repoRoot: REPO_ROOT, governanceDir: dir }),
      ).rejects.toBeInstanceOf(GovernanceStateValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('W052-AC02 — a missing governance directory is a typed failure (never a vacuous empty state)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfos-gov-empty-'));
    try {
      await expect(
        DefaultDevelopmentGovernanceService.create({ repoRoot: REPO_ROOT, governanceDir: dir }),
      ).rejects.toBeInstanceOf(GovernanceStateValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- W052-AC07: crash/restart/resume -----------------------------------------

  it('W052-AC07 — crash/restart/resume: a fresh control-plane instance reconstructs the resumption view from repository-resident state', async () => {
    // A fixture repository-resident state representing an INTERRUPTED
    // implementation (the "coordinating process" died): the state lives ONLY
    // in the files below — no process memory, no chat context.
    const dir = mkdtempSync(join(tmpdir(), 'wfos-gov-resume-'));
    try {
      const program: ProgramState = structuredClone(realProgram);
      const w052 = program.workOrders.find((w) => w.id === 'WORK-052')!;
      w052.status = 'in_flight';
      w052.branch = 'feat/work-052-development-governance';
      w052.pr = 63;
      program.resumption.activeHandoffs = [
        {
          workOrderId: 'WORK-052',
          lastVerifiedState: 'step 3 of 5 complete: loader + service + detector implemented; static invariants green',
          nextSteps: ['write the integration tests', 'run the full real-PG sweep', 'open the PR'],
          blockers: [],
          recordedAt: '2026-08-28T11:00:00Z',
          recordedBy: 'the interrupted implementation agent',
        },
      ];
      mkdirSync(join(dir), { recursive: true });
      writeFileSync(join(dir, 'governance-model.json'), JSON.stringify(realModel, null, 2));
      writeFileSync(join(dir, 'program-state.json'), JSON.stringify(program, null, 2));

      // "Restart the coordinating process": a NEW service instance from the
      // same repository-resident state.
      const restarted = await DefaultDevelopmentGovernanceService.create({
        repoRoot: REPO_ROOT,
        governanceDir: dir,
      });
      const view = restarted.resumeImplementation('WORK-052');
      expect(view.workOrderId).toBe('WORK-052');
      expect(view.status).toBe('in_flight');
      expect(view.branch).toBe('feat/work-052-development-governance');
      expect(view.handoff.lastVerifiedState).toContain('step 3 of 5');
      expect(view.handoff.nextSteps).toEqual(['write the integration tests', 'run the full real-PG sweep', 'open the PR']);
      // The resumption view carries EVERYTHING a fresh agent needs: the work
      // order reference, the assurance contract, the protocol rules, the
      // governing documents, and the constraining decisions.
      expect(view.workOrderRef).toBe('spec/work-orders/WORK-052.md');
      expect(view.assurance.profile).toBe('CRITICAL');
      expect(view.assurance.architectReviewRecord).toBe(true);
      expect(view.parallelProtocolRules.length).toBeGreaterThanOrEqual(6);
      expect(view.governingDocuments.length).toBeGreaterThanOrEqual(5);
      expect(view.decisions.filter((d) => d.kind === 'adr').length).toBeGreaterThanOrEqual(6);
      expect(view.dependencies.map((d) => d.id)).toContain('WORK-051');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('W052-AC07 — resuming a work order with no handoff record fails closed (NoResumableStateError)', () => {
    // WORK-048 is pending with no handoff — nothing to resume.
    expect(() => service.resumeImplementation('WORK-048')).toThrow(NoResumableStateError);
  });

  it('W052-AC07 — an unknown work order is a typed error (no nearest-match fallback)', () => {
    expect(() => service.getWorkOrder('WORK-999')).toThrow(UnknownWorkOrderError);
    expect(() => service.getWorkOrder('work-052')).toThrow(UnknownWorkOrderError);
  });
});

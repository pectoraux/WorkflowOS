import { describe, it, expect } from 'vitest';
import {
  packageFirstPartyExecution,
  artifactByKind,
  type AttestationVerification,
  type FirstPartyWorkflowManifest,
  type FirstPartyPinFacts,
  type PackageFirstPartyExecutionInput,
  type SelfHostingPackagingResult,
} from '../../../src/self-hosted-library/index.js';
import { InMemoryReplayRegistry } from '../../../src/execution-attestation/index.js';
import { CORE_SELF_HOSTING_PROHIBITIONS } from '../../../src/architecture-checkpoints/index.js';
import {
  makeDevEnvironment,
  buildDevStatement,
  signDevStatement,
  verifyDevAttestation,
  DEV_ATTESTER,
  DEV_ATTESTER_UNTRUSTED,
  DEV_EPOCH,
  DEV_PACKAGING_NOW,
  DEV_RUN_ID,
  DEV_TENANT,
} from './helpers.js';

/**
 * V2-013 Task 5 — the safe execution packaging battery (real cryptography).
 *
 * Proves (the frozen regressions "rejection of invalid/replayed
 * execution-proof predicates where consumed" + "workflow version pinning" +
 * the boundary/packaging composition):
 *
 *   - the CONTROL: a valid, fresh, authorized predecessor fact (REAL
 *     Ed25519 attestation, verified by the REAL V2-014 verifier, admitted
 *     through the REAL V2-015 admission) → the package is MINTED carrying
 *     the admitted predicate (satisfied parents + trusted attesters);
 *   - single-dimension mutations each deny with the CORRECT typed code:
 *     · a FAILED verification (replayed nonce through the SAME registry)
 *       → SELF_HOSTING_PROOF_PREDICATE_REJECTED carrying V2-015's
 *       ADMISSION_PREDECESSOR_UNVERIFIED with V2-014's ATTESTATION_REPLAYED
 *       verbatim;
 *     · an UNTRUSTED attester (verification fails) → predicate rejected;
 *     · the wrapper/fact identity substitution (the PR #158 Blocker-1
 *       shape) → predicate rejected with ADMISSION_EVIDENCE_IDENTITY_
 *       MISMATCH;
 *     · a MISSING evidence supply for a proof-required step →
 *       SELF_HOSTING_PROOF_STEP_UNSUPPLIED;
 *   - pin drift (the manifest pin vs the read-back pin facts) →
 *     SELF_HOSTING_PIN_DRIFT;
 *   - a weakened boundary model → SELF_HOSTING_BOUNDARY_MODEL_INVALID;
 *   - a manifest/artifact mismatch → SELF_HOSTING_MANIFEST_MISMATCH.
 */

/** The real governance boundary shape. */
function realBoundary() {
  return {
    may: ['plan its own implementation (architect-issued Work Orders)'],
    mayNot: [...CORE_SELF_HOSTING_PROHIBITIONS],
    coreProhibitions: [...CORE_SELF_HOSTING_PROHIBITIONS],
  };
}

function realTrustPolicy() {
  return {
    trustedAttesterKeyIds: [DEV_ATTESTER.keyId],
    requiredAssurance: 'software_signed' as const,
    now: DEV_PACKAGING_NOW,
    currentEpoch: DEV_EPOCH,
    maxVerificationAgeMs: 10 * 60 * 1000,
  };
}

interface PackagingFixture {
  readonly manifest: FirstPartyWorkflowManifest;
  readonly pinFacts: FirstPartyPinFacts;
  readonly scope: {
    readonly workflowId: string;
    readonly workflowVersionId: string;
    readonly workflowVersionSemanticDigest: string;
    readonly runId: string;
  };
  /** The REAL predecessor attestation (the install step, re-derivable deterministically). */
  readonly predecessor: ReturnType<typeof signDevStatement>;
  /** The baseline trusted verification of the predecessor. */
  readonly verification: AttestationVerification;
}

/**
 * The packaging baseline: the dogfooding procedure (its execute_workflow
 * step is proof-required), a REAL predecessor attestation for the run
 * step BEFORE it (install_workflow), verified fresh and trusted.
 */
async function makePackagingFixture(): Promise<PackagingFixture> {
  const { manifests } = await makeDevEnvironment();
  const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
  const pinFacts: FirstPartyPinFacts = {
    organizationId: DEV_TENANT,
    installationId: manifest.installationId,
    workflowId: manifest.workflowId,
    versionId: manifest.versionId,
    versionNumber: manifest.versionNumber,
    contentDigest: manifest.contentDigest,
  };
  const scope = {
    workflowId: manifest.workflowId,
    workflowVersionId: manifest.versionId,
    workflowVersionSemanticDigest: manifest.semanticDigest.digest,
    runId: DEV_RUN_ID,
  };
  const predecessor = signDevStatement(
    buildDevStatement(scope, {
      stepId: 'install_workflow',
      nodeId: 'node_dev_self_hosted_worker',
      action: 'Install the first-party workflow through the universal installation authority (version-pinned)',
      nonce: 'challenge-dev-dogfood-install-0001',
    }),
  );
  const verification = verifyDevAttestation(predecessor, scope);
  return { manifest, pinFacts, scope, predecessor, verification };
}

function baselineInput(
  fixture: PackagingFixture,
  verification: AttestationVerification = fixture.verification,
): PackageFirstPartyExecutionInput {
  return {
    artifact: artifactByKind('dogfooding')!,
    manifest: fixture.manifest,
    boundary: realBoundary(),
    pinFacts: fixture.pinFacts,
    executionScope: { runId: DEV_RUN_ID },
    trustPolicy: realTrustPolicy(),
    proofSteps: [
      {
        stepId: 'execute_workflow',
        declaredParents: [fixture.predecessor.executionDigest.digest],
        predecessorEvidence: [
          { executionDigest: fixture.predecessor.executionDigest.digest, verification },
        ],
      },
    ],
  };
}

function expectDeniedCode(result: SelfHostingPackagingResult, code: string) {
  if (result.packaged) {
    throw new Error(`expected denial ${code}, got a minted package`);
  }
  expect(result.failure.code).toBe(code);
  return result.failure;
}

describe('V2-013 execution packaging — the control (valid, fresh, authorized proof predicate)', () => {
  it('a REAL verified predecessor fact → the package is minted with the admitted predicate', async () => {
    const fixture = await makePackagingFixture();
    expect(fixture.verification.ok).toBe(true);
    const result = packageFirstPartyExecution(baselineInput(fixture));
    if (!result.packaged) {
      throw new Error(`expected packaged, got ${result.failure.code}: ${result.failure.detail}`);
    }
    expect(result.package.kind).toBe('dogfooding');
    expect(result.package.runId).toBe(DEV_RUN_ID);
    expect(result.package.versionId).toBe(fixture.manifest.versionId);
    expect(result.package.boundaryCoreProhibitions).toEqual(CORE_SELF_HOSTING_PROHIBITIONS);
    expect(result.package.admittedProofSteps).toHaveLength(1);
    expect(result.package.admittedProofSteps[0]!.stepId).toBe('execute_workflow');
    expect(result.package.admittedProofSteps[0]!.satisfiedParents).toEqual([fixture.predecessor.executionDigest.digest]);
    expect(result.package.admittedProofSteps[0]!.trustedAttesterKeyIds).toEqual([DEV_ATTESTER.keyId]);
  });
});

describe('V2-013 execution packaging — invalid/replayed proof predicates are rejected typed', () => {
  it("a REPLAYED predecessor (the same nonce verified twice through one registry) → predicate rejected with V2-014's replay code carried verbatim", async () => {
    const fixture = await makePackagingFixture();
    // first verification consumes the nonce; the SECOND (the replay) is
    // refused typed by V2-014 through the SAME registry
    const registry = new InMemoryReplayRegistry();
    const first = verifyDevAttestation(fixture.predecessor, fixture.scope, { replayRegistry: registry });
    expect(first.ok).toBe(true);
    const replayed = verifyDevAttestation(fixture.predecessor, fixture.scope, { replayRegistry: registry });
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect(replayed.failure.code).toBe('ATTESTATION_REPLAYED');
    }
    const result = packageFirstPartyExecution(baselineInput(fixture, replayed));
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_PREDICATE_REJECTED');
    expect(failure.stepId).toBe('execute_workflow');
    expect(failure.admissionFailure?.code).toBe('ADMISSION_PREDECESSOR_UNVERIFIED');
    expect(failure.admissionFailure?.verifierFailureCode).toBe('ATTESTATION_REPLAYED');
  });

  it("an UNTRUSTED attester's attestation (verification fails) → predicate rejected (the empty-trust rule holds through packaging)", async () => {
    const fixture = await makePackagingFixture();
    // sign the SAME predecessor statement with the UNTRUSTED key
    const { signExecutionAttestation } = await import('../../../src/execution-attestation/index.js');
    const foreign = signExecutionAttestation({
      statement: fixture.predecessor.statement,
      attesterPrivateKey: DEV_ATTESTER_UNTRUSTED.privateKey,
      attesterPublicKeyDer: DEV_ATTESTER_UNTRUSTED.publicKeyDer,
      assurance: 'software_signed',
      issuedAt: '2026-09-03T08:00:01.000Z',
    });
    // the verification policy trusts ONLY DEV_ATTESTER → typed failure
    const verification = verifyDevAttestation(foreign, fixture.scope);
    expect(verification.ok).toBe(false);
    const result = packageFirstPartyExecution(baselineInput(fixture, verification));
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_PREDICATE_REJECTED');
    expect(failure.admissionFailure?.code).toBe('ADMISSION_PREDECESSOR_UNVERIFIED');
  });

  it('the wrapper/fact identity substitution (the PR #158 Blocker-1 shape) → predicate rejected with the identity-mismatch code', async () => {
    const fixture = await makePackagingFixture();
    expect(fixture.verification.ok).toBe(true);
    // the SAME verified fact retained under a SUBSTITUTED wrapper digest,
    // the declared parent following the wrapper (the attack shape)
    const substituted = 'ab'.repeat(32);
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      proofSteps: [
        {
          stepId: 'execute_workflow',
          declaredParents: [substituted],
          predecessorEvidence: [{ executionDigest: substituted, verification: fixture.verification }],
        },
      ],
    });
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_PREDICATE_REJECTED');
    expect(failure.admissionFailure?.code).toBe('ADMISSION_EVIDENCE_IDENTITY_MISMATCH');
  });

  it('a MISSING evidence supply for the proof-required step → SELF_HOSTING_PROOF_STEP_UNSUPPLIED (absence never satisfies)', async () => {
    const fixture = await makePackagingFixture();
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      proofSteps: [],
    });
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_STEP_UNSUPPLIED');
    expect(failure.stepId).toBe('execute_workflow');
  });
});

describe('V2-013 execution packaging — pin drift, boundary, and manifest correspondence', () => {
  it('pin drift (the read-back pin no longer matches the manifest) → SELF_HOSTING_PIN_DRIFT', async () => {
    const fixture = await makePackagingFixture();
    const drifted: FirstPartyPinFacts = {
      ...fixture.pinFacts,
      versionId: 'wfwv-moved-silently',
      versionNumber: 2,
      contentDigest: 'digest-moved',
    };
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      pinFacts: drifted,
    });
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PIN_DRIFT');
    expect(failure.expected).toBe(`${fixture.manifest.workflowId}@${fixture.manifest.versionId}`);
    expect(failure.actual).toBe(`${fixture.manifest.workflowId}@wfwv-moved-silently`);
  });

  it('a WEAKENED boundary model → SELF_HOSTING_BOUNDARY_MODEL_INVALID (the packaging never opens on governance weakening)', async () => {
    const fixture = await makePackagingFixture();
    const weakened = {
      may: ['plan its own implementation'],
      mayNot: CORE_SELF_HOSTING_PROHIBITIONS.slice(0, 7),
      coreProhibitions: CORE_SELF_HOSTING_PROHIBITIONS.slice(0, 7),
    };
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      boundary: weakened,
    });
    expectDeniedCode(result, 'SELF_HOSTING_BOUNDARY_MODEL_INVALID');
  });

  it('a manifest/artifact mismatch (the WRONG manifest for the artifact) → SELF_HOSTING_MANIFEST_MISMATCH', async () => {
    const fixture = await makePackagingFixture();
    // supply the TESTING manifest with the DOGFOODING artifact
    const { manifests } = await makeDevEnvironment();
    const testingManifest = manifests.find((m) => m.kind === 'testing')!;
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      manifest: { ...testingManifest, installationId: fixture.manifest.installationId },
    });
    expectDeniedCode(result, 'SELF_HOSTING_MANIFEST_MISMATCH');
  });
});

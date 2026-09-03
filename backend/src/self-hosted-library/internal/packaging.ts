/**
 * V2-013 — internal/safe first-party execution packaging.
 *
 * The typed, fail-closed decision that a pinned first-party workflow may
 * be dispatched for execution in a development environment — for ONE real
 * run (the V2-016 precondition pattern: the package is the run's
 * precondition set, minted BEFORE dispatch through the real execution
 * authorities, which stay external).
 *
 * The fixed evaluation order (deterministic, first failure returned):
 *   1. the self-hosting permission boundary (fail-closed against a
 *      weakened governance model — the code-pinned floor);
 *   2. the manifest↔artifact correspondence (kind, slug, semantic digest);
 *   3. the installation pin proof (the manifest pin vs the pin facts read
 *      back from the REAL V2-002 authority — drift is fail-closed);
 *   4. the proof predicates for every policy-declared proof-required
 *      step, consumed through V2-015's `evaluateProofAdmission` (the
 *      verified-fact admission — V2-015/V2-014 stay the authorities; the
 *      admission failure is carried VERBATIM, never reinterpreted);
 *   5. only then is the package minted.
 *
 * Pure and deterministic: no clock, no randomness, no network.
 */

import { computeWorkflowVersionSemanticDigest } from '../../workflow-ir/index.js';
import { evaluateProofAdmission } from '../../execution-proof-graph/index.js';
import type { ProofAdmissionInput } from '../../execution-proof-graph/index.js';
import type {
  FirstPartyWorkflowArtifact,
  FirstPartyWorkflowManifest,
  PackageFirstPartyExecutionInput,
  ProofStepEvidenceInput,
  SelfHostingPackagingFailure,
  SelfHostingPackagingResult,
} from '../types.js';
import { evaluateSelfHostingBoundary } from './boundary.js';

/**
 * Package one first-party workflow execution for one run. Fail-closed:
 * ANY failed dimension returns the typed failure and mints NOTHING.
 */
export function packageFirstPartyExecution(input: PackageFirstPartyExecutionInput): SelfHostingPackagingResult {
  // ------------------------------------------------------------------
  // 1. the self-hosting permission boundary (fail-closed)
  // ------------------------------------------------------------------
  const verdict = evaluateSelfHostingBoundary(input.artifact.document, input.boundary);
  if (!verdict.allowed) {
    return {
      packaged: false,
      failure: {
        code:
          verdict.failure.code === 'SELF_HOSTING_BOUNDARY_MODEL_INVALID'
            ? 'SELF_HOSTING_BOUNDARY_MODEL_INVALID'
            : 'SELF_HOSTING_BOUNDARY_DENIED',
        detail: `the self-hosting permission boundary denied the ${input.artifact.kind} workflow: ${verdict.failure.code} — ${verdict.failure.detail}`,
        boundaryFailure: verdict.failure,
      },
    };
  }

  // ------------------------------------------------------------------
  // 2. manifest ↔ artifact correspondence
  // ------------------------------------------------------------------
  const semanticDigest = computeWorkflowVersionSemanticDigest(input.artifact.document);
  if (
    input.manifest.kind !== input.artifact.kind ||
    input.manifest.slug !== input.artifact.slug ||
    input.manifest.semanticDigest.digest !== semanticDigest.digest
  ) {
    return {
      packaged: false,
      failure: {
        code: 'SELF_HOSTING_MANIFEST_MISMATCH',
        detail:
          `the manifest does not correspond to the supplied artifact (kind/slug/semantic digest mismatch: manifest ${input.manifest.kind}/${input.manifest.slug}/${input.manifest.semanticDigest.digest.slice(0, 12)}… vs artifact ${input.artifact.kind}/${input.artifact.slug}/${semanticDigest.digest.slice(0, 12)}…)`,
      },
    };
  }

  // ------------------------------------------------------------------
  // 3. the installation pin proof (drift = fail-closed)
  // ------------------------------------------------------------------
  const pin = input.pinFacts;
  if (
    pin.installationId !== input.manifest.installationId ||
    pin.workflowId !== input.manifest.workflowId ||
    pin.versionId !== input.manifest.versionId ||
    pin.versionNumber !== input.manifest.versionNumber ||
    pin.contentDigest !== input.manifest.contentDigest
  ) {
    return {
      packaged: false,
      failure: {
        code: 'SELF_HOSTING_PIN_DRIFT',
        detail:
          `the installed pin no longer matches the manifest (a silent pin move is fail-closed: expected version ${input.manifest.versionId} (digest ${input.manifest.contentDigest.slice(0, 12)}…), the authority reports version ${pin.versionId} (digest ${pin.contentDigest.slice(0, 12)}…))`,
        expected: `${input.manifest.workflowId}@${input.manifest.versionId}`,
        actual: `${pin.workflowId}@${pin.versionId}`,
      },
    };
  }

  // ------------------------------------------------------------------
  // 4. the proof predicates (V2-015 admission, consumed verbatim)
  // ------------------------------------------------------------------
  const admitted: {
    stepId: string;
    satisfiedParents: readonly string[];
    trustedAttesterKeyIds: readonly string[];
  }[] = [];
  const supplies = new Map<string, ProofStepEvidenceInput>();
  for (const supply of input.proofSteps) {
    supplies.set(supply.stepId, supply);
  }
  for (const stepId of input.artifact.executionPolicy.proofRequiredSteps) {
    const supply = supplies.get(stepId);
    if (!supply) {
      return {
        packaged: false,
        failure: {
          code: 'SELF_HOSTING_PROOF_STEP_UNSUPPLIED',
          detail: `the proof-required step "${stepId}" has NO predecessor-evidence supply (fail-closed: a proof predicate is never satisfied by absence)`,
          stepId,
        },
      };
    }
    const admissionInput: ProofAdmissionInput = {
      dependent: {
        stepId,
        workflowId: input.manifest.workflowId,
        workflowVersionId: input.manifest.versionId,
        workflowVersionSemanticDigest: input.manifest.semanticDigest.digest,
        runId: input.executionScope.runId,
      },
      declaredParents: supply.declaredParents,
      predecessorEvidence: supply.predecessorEvidence,
      trustPolicy: input.trustPolicy,
      ...(supply.capabilityRequirement !== undefined ? { capabilityRequirement: supply.capabilityRequirement } : {}),
      ...(supply.capabilityFacts !== undefined ? { capabilityFacts: supply.capabilityFacts } : {}),
      ...(supply.authorizationRequired !== undefined ? { authorizationRequired: supply.authorizationRequired } : {}),
      ...(supply.authorizationGrants !== undefined ? { authorizationGrants: supply.authorizationGrants } : {}),
      ...(supply.dependentCapability !== undefined ? { dependentCapability: supply.dependentCapability } : {}),
    };
    const admission = evaluateProofAdmission(admissionInput);
    if (!admission.admitted) {
      return {
        packaged: false,
        failure: {
          code: 'SELF_HOSTING_PROOF_PREDICATE_REJECTED',
          detail: `the proof predicate for step "${stepId}" was REJECTED by the V2-015 admission: ${admission.failure.code} — ${admission.failure.detail}`,
          admissionFailure: admission.failure,
          stepId,
        },
      };
    }
    admitted.push({
      stepId,
      satisfiedParents: [...admission.satisfiedParents],
      trustedAttesterKeyIds: [...admission.trustedAttesterKeyIds],
    });
  }

  // ------------------------------------------------------------------
  // 5. mint the package (the run's precondition set)
  // ------------------------------------------------------------------
  return {
    packaged: true,
    package: {
      kind: input.manifest.kind,
      workflowId: input.manifest.workflowId,
      versionId: input.manifest.versionId,
      versionNumber: input.manifest.versionNumber,
      contentDigest: input.manifest.contentDigest,
      semanticDigest: input.manifest.semanticDigest,
      installationId: input.manifest.installationId,
      runId: input.executionScope.runId,
      boundaryCoreProhibitions: [...input.boundary.coreProhibitions],
      admittedProofSteps: admitted,
    },
  };
}

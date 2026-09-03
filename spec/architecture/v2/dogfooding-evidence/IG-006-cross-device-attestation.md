# IG-006 — Cross-Device Execution Attestation Composition

## Status

**Re-proof candidate: post-V2-016.** This evidence supersedes the blocked PR #152 attempt without rebasing or mutating that historical branch.

## What is being proved

A single durable WorkflowRun and immutable WorkflowVersion compose across a web host (Node A) and desktop host (Node B). Node A produces a real Ed25519 `ExecutionAttestation`; its canonical envelope is transferred and independently verified under Node B's verifier context. The resulting V2-014 `VerifiedExecutionFact` is consumed as a V2-016 `DependentStepPrecondition` at the real `resumeAfterHuman` boundary before the dependent side effect.

The dependent Node-B execution is itself attested, and the runtime-produced V2-014 statement carries exactly Node A's execution digest in `causalParents`. The dependent attestation is independently checked with the causal-parent binding; a wrong-parent expectation is rejected by the canonical verifier.

## Required composition properties covered

P1 — same Run/WorkflowVersion identity across both hosts.

P2 — Node-A attestation produced, independently checked, and durably attached.

P3 — Node-B verification result is consumed by V2-008 admission through the V2-016 precondition; the missing-precondition regression proves fail-closed behavior with no dependent filesystem write.

P4 — replay, freshness epoch, and expiry are checked by the V2-014 verifier; duplicate attestation delivery and duplicate V2-005 attach converge.

P5 — runtime-produced dependent attestation carries the actual predecessor execution digest in `causalParents`; the canonical verifier accepts the correct parent and rejects a wrong parent.

P6 — duplicate event, duplicate attestation delivery, duplicate attach, and repeated host invocation converge without a second durable side effect.

P7 — capability advertisement remains distinct from authorization; an advertised filesystem write capability without a safe-action grant is rejected with zero write effect.

P8 — insufficient trust and insufficient attestation assurance remain explicit typed failures.

P9 — durable history reconstructs the run, steps, invocations, evidence, attestation bindings, and evidence references.

## Dogfooding requirement

The standalone runner uses the real PGlite-backed application stack, real V2-002/V2-005/V2-009 route surfaces, two V2-004-registered supported host kinds, real Ed25519 attestation keys, an independent verifier process over the canonical envelope bytes, V2-016 admission on Node B, and a real `node:fs` write through `RealFilesystemDesktopEnvironment`.

The runner executes the experiment twice and compares a normalized deterministic core transcript. Raw Ed25519 signatures and generated identities are deliberately not used as determinism material.

## Historical disposition

PR #152 (`feat/ig-006-cross-device-attestation`) is preserved as the original fail-closed blocked attempt against the pre-V2-016 contract. It is not rebased and is not used as the implementation base for this re-proof.

V2-015 remains gated on completion of this re-proof and architect merge.

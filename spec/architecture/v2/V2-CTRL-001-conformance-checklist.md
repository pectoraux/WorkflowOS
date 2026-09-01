# V2-CTRL-001 — Implementation Conformance Checklist

**Status:** REQUIRED CONTROL ARTIFACT

Every V2 implementation agent MUST read, apply, and truthfully satisfy this checklist before opening a PR. It is a control artifact, not a product capability.

## Pre-implementation

- [ ] Read `V2-CTRL-000`, the Constitution, `V2-CTRL-003`, the Control Plane, `V2-CTRL-002`, dogfooding protocol, machine state and assigned Work Order.
- [ ] Read `spec/architecture/v2/execution-attestation.md` whenever execution proof, attestation, cryptographic evidence, trust, or cross-device coordination is in scope.
- [ ] Verify current `main` SHA from GitHub.
- [ ] Verify every hard dependency is actually COMPLETE and every contract dependency is merged/frozen.
- [ ] Verify no sibling parallel branch is being used as a base.
- [ ] Record exact change surface and exclusions before coding.

## Architecture invariants

- [ ] Workflow is the durable repository identity.
- [ ] WorkflowVersion is immutable and addressable.
- [ ] WorkflowIR is the semantic source of truth.
- [ ] Teaching traces, recordings, prompts, compiled artifacts and marketplace listings are not WorkflowIR.
- [ ] Web, desktop, iOS, Android and cloud use the same protocol semantics.
- [ ] Protocol-visible names reuse `V2-CTRL-003`; aliases are not introduced casually.
- [ ] Capability possession is not authorization.
- [ ] Placement/locality/privacy constraints remain explicit.
- [ ] Deterministic/API, agentic/computer-use, human, and subworkflow execution remain distinct classes.
- [ ] Model assertions do not become side-effect evidence.
- [ ] Every execution is pinned to an immutable WorkflowVersion.
- [ ] Marketplace entitlement never becomes execution authority.
- [ ] Publisher maintenance cannot silently mutate an installed version.
- [ ] V1 authority is not silently rewritten or replaced.
- [ ] ExecutionDigest is distinct from WorkflowVersion digest.
- [ ] ExecutionAttestation authenticates a statement but does not automatically become verification truth.
- [ ] Attestations bind to Run/attempt/step, causal context and freshness when decision-relevant.
- [ ] Node identity, workload identity, capability, authorization, trust, assurance and verification remain separate.
- [ ] ExecutionProofGraph is evidence about executions, never a replacement workflow graph.

## Implementation

- [ ] No second workflow protocol introduced.
- [ ] No second workflow engine introduced.
- [ ] No platform-specific workflow semantics introduced.
- [ ] No second source of truth introduced for an existing V2 concept.
- [ ] Secret material is never stored in workflow definitions, ordinary protocol payloads or marketplace metadata.
- [ ] Cross-process state uses explicit durable semantics where claimed.
- [ ] Event-triggered actions are idempotent where duplicate delivery is possible.
- [ ] Unknown/unsupported assurance fails closed where policy requires it.
- [ ] No blockchain/transparency service is made a mandatory correctness dependency.

## Verification

- [ ] Deterministic unit/contract tests added or updated.
- [ ] Discrimination/mutation tests prove the key invariant is load-bearing.
- [ ] Real-system integration tests run when required.
- [ ] Concurrency/crash testing exists for cross-process/durable claims.
- [ ] Cryptographic tests use real signing/verification rather than only mocks.
- [ ] Replay, freshness, wrong-run, wrong-step and wrong-parent negatives exist where attestation is decision-relevant.
- [ ] Assurance downgrade and capability-vs-authorization negatives exist where applicable.
- [ ] Exact final-head verification rerun after the final evidence/documentation change.

## Dogfooding

- [ ] Feature is exercised through the real supported product path.
- [ ] Feature-boundary attestation dogfood includes a positive real-crypto verification and a negative tamper/stale/replay experiment.
- [ ] Cross-device proof features exercise at least two real supported hosts when their required capabilities exist.
- [ ] Evidence records exact version/surface/task/expected/observed/result.
- [ ] Unsafe operations use isolated resources or explicit confirmation.
- [ ] Findings are preserved even when negative.
- [ ] Contract-relevant failures block dependent work.
- [ ] Unrelated findings become separate corrective Work Orders.
- [ ] Integration gates receive a second cross-feature dogfooding experiment.

## PR / completion

- [ ] PR starts from a stable base and contains only declared scope.
- [ ] Parallel siblings remain independently mergeable without rebase.
- [ ] CI is verified on the exact PR head.
- [ ] Work Order state remains accurate and is not marked COMPLETE before actual merge plus required evidence.
- [ ] After merge, finalization uses the real merge SHA.
- [ ] Next eligible wave is derived from canonical machine state, not conversation memory.

## Stop conditions

An implementation agent MUST stop and escalate through a governed architecture change when:

- a frozen V2 concept must be reinterpreted;
- two authoritative surfaces cannot be independently mergeable without semantic compromise;
- a claimed execution proof cannot be objectively verified at its declared assurance level;
- a signature is being treated as automatic proof of a physical side effect;
- freshness/replay protection cannot be proven;
- a required platform capability cannot be honestly represented;
- durable semantics are claimed but the actual composed adapter is not durable;
- dogfooding reveals a contract-level failure outside the Work Order's scope;
- implementation would require silently reviving deferred V1 work;
- an integration gate would require modifying a merged sibling merely to make composition possible.

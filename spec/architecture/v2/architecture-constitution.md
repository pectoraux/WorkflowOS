# WorkflowOS 2.0 — Architecture Constitution

**Status:** PROPOSED / implementation-authorized V2 constitution  
**Precedence:** This document governs interpretation of all V2 Work Orders while V2 remains proposed. Implementation is authorized by `V2-CTRL-000`; formal V2 freezing remains a separate governed architecture-version decision.
**Canonical protocol registry:** `V2-CTRL-003-protocol-registry.md` + `V2-CTRL-003-protocol-registry.json`

## 1. Product thesis

WorkflowOS turns how people work with computers into reusable, executable, versioned software.

A person can describe a procedure with text, voice, or demonstration; install and execute workflows; pause/resume teaching; run locally on desktop/mobile, in a browser, or in the cloud; optimize workflows into new versions; collaborate/fork/share them; purchase them once or subscribe to maintenance; and reverse-teach from an installed workflow to a human.

## 2. Primary artifact hierarchy

```text
WorkflowRepository
  └── Workflow
       ├── immutable WorkflowVersion
       │    └── WorkflowIR
       └── WorkflowDeployment
              └── WorkflowRun
```

`WorkflowIR` is the semantic source of truth. Nothing below this hierarchy may redefine these concepts.

## 3. Universal protocol and host neutrality

Web, desktop, iOS, Android and cloud use exactly one WorkflowOS protocol for semantic operations. Platform differences are represented through capabilities, permissions, UX, lifecycle, connectivity and placement availability. They never create separate workflow semantics or engines.

## 4. Node and capability authority

A Node advertises capabilities; it does not grant authorization. Eligibility is the conjunction of capability availability, workflow policy, user/organization authorization, placement constraints and node trust/health. Missing capabilities are explicit ineligible results.

## 5. Execution classes

Every workflow step is one of `deterministic_api`, `agentic_computer_use`, `human`, or `subworkflow`. Prefer deterministic/API execution when semantic equivalence is established. Computer-use is bounded by WorkflowIR, capability, authorization, policy, placement and evidence requirements.

## 6. Evidence truth

The system distinguishes intent, observation, claim/assertion, verification and human confirmation. A model statement is not side-effect evidence. Side effects are completed only when the configured evidence/verification policy establishes completion.

## 7. Workflow teaching and demonstration capture

Teaching is a derived view over the same immutable WorkflowVersion. Demonstration capture is immutable provenance and is compiled into WorkflowIR; raw interaction replay is not the canonical workflow.

## 8. Optimization

Optimization is advisory and version-producing. It cannot silently mutate an installed version.

## 9. Events and locality

Triggers are typed event patterns. Event-triggered execution has stable correlation and duplicate-delivery idempotency. Locality is a correctness constraint. Cross-device handoff preserves WorkflowVersion, Run identity, causation and evidence and must not duplicate side effects.

## 10. Execution attestation

WorkflowOS supports a protocol-native distinction between execution commitment and execution truth:

```text
ExecutionStatement
   ↓
ExecutionDigest
   ↓
ExecutionAttestation
   ↓
verification/appraisal
   ↓
VerifiedExecutionFact
```

Rules:

- `ExecutionDigest` is distinct from the WorkflowVersion semantic digest.
- Execution statements use deterministic, domain-separated canonical serialization.
- An attestation authenticates an attester's statement; a signature does not automatically prove physical execution or side-effect completion.
- Decision-relevant attestations bind to the exact WorkflowVersion, Run, execution attempt, relevant step, causal parents and freshness context.
- Freshness/replay resistance is mandatory where attestations affect current decisions; timestamps alone are insufficient.
- Node identity, workload identity, capability possession, authorization, placement, policy, cryptographic authenticity, assurance and verification remain separate dimensions.
- Assurance may be `software_signed`, `hardware_backed`, `tee_attested`, or `verifiable_computation`. These are evidence/trust properties, not workflow execution classes.
- Stronger attestation mechanisms may be unavailable on some hosts. The protocol must represent unavailable assurance honestly rather than silently substitute a weaker mechanism.
- Execution attestations do not create a second workflow, execution, authorization or verification authority.
- ExecutionProofGraph is evidence about WorkflowRuns, never an alternative WorkflowIR or workflow engine.
- External transparency logs, ledgers, blockchains, TEEs or zero-knowledge systems are optional evidence/assurance mechanisms, not baseline execution dependencies.

## 11. Security and privacy

Sensitive capabilities retain distinct authorization/consent boundaries. Secrets are not stored in WorkflowIR or ordinary protocol payloads. Attestation payloads expose only what the verification policy requires and may use commitments or opaque references.

## 12. Marketplace

Entitlement grants content/version access only; it never grants execution authority, secrets, capability permissions or attestation authority.

## 13. Anti-drift and authority preservation

V2 Work Orders may extend protocol contracts only through governed architecture change. Existing authorities are not duplicated. V1 remains frozen and is consumed only through explicit boundaries/adapters.

## 14. Quality and dogfooding

Tests prove implementation correctness. Real-system proofs establish cross-process/cryptographic behavior. Feature-boundary dogfooding is mandatory for every user-facing or execution-facing feature. Integration gates require cross-feature dogfooding. Contract-relevant failures block downstream work; unrelated findings become targeted Work Orders. Parallelism never removes verification, security checks, evidence requirements or dogfooding.

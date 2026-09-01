# WorkflowOS 2.0 Architecture

**Status: PROPOSED / implementation-authorized.** The frozen v1.0 architecture remains authoritative until a governed V2 architecture version is formally frozen. Implementation authorization is recorded in `V2-CTRL-000-implementation-authorization.md`.

WorkflowOS 2.0 is a computer-workflow operating system. Its primary durable artifact is a versioned Workflow that can be authored from text, voice, demonstrations, or hybrids; deployed to capable web/desktop/mobile/cloud nodes; executed under explicit policy; scheduled or event-triggered; optimized through new versions; collaboratively forked/merged; sold or subscribed to; and used in reverse to teach people.

## V1 → V2 transition

The forward product roadmap is now V2. Remaining V1 roadmap items are **deferred by default** and may resume only for a concrete V2 dependency, compatibility/security requirement, or explicit architect reactivation. This transition is normative and persisted at `spec/architecture/v2/v1-transition.md`.

## Canonical V2 control plane

Read these as the repository-resident source of truth:

- `V2-CTRL-000-implementation-authorization.md`
- `architecture-constitution.md`
- `V2-CTRL-003-protocol-registry.md` + `.json`
- `execution-control-plane.md`
- `V2-CTRL-001-conformance-checklist.md`
- `V2-CTRL-002-roadmap-lock.md`
- `dogfooding-protocol.md`
- `fresh-architect-bootstrap.md`
- `spec/development-state/v2-work-order-state.json`
- `architecture-change-requests/V2-ACR-001-execution-attestation.md`

## V2 architecture sequence

The product sequence is an index, not the execution order:

`V2-001 → V2-002 → V2-003 → V2-004 → V2-006/V2-007/V2-014 → V2-005 → V2-008 → V2-009/V2-010/V2-011 → IG-006 → V2-012/V2-015 → V2-013`

The **canonical execution order is the wave graph in `V2-CTRL-002-roadmap-lock.md` and `v2-work-order-state.json`**, not this sequence string.

## Wave model

```text
W0   V2-001 COMPLETE
        ↓
W1   V2-002   V2-003   V2-004             ← parallel / no rebase
        ↓
W2A  V2-006   V2-007   V2-014             ← parallel / no rebase
        ↓
W2B  V2-005                              ← Run/evidence consumes attestation contract
        ↓
W3   IG-001 + IG-002 → V2-008             ← integration then computer execution
        ↓
W4   V2-009   V2-010   V2-011              ← parallel / no rebase
        ↓
     IG-006                                ← cross-device attestation composition
        ↓
W5   V2-012   V2-015                      ← parallel / no rebase
        ↓
W6   V2-013
```

## Core product architecture

The protocol and semantic contracts are the foundation. Platform applications are clients/hosts of the same protocol, not separate workflow engines. Existing WorkflowOS software-engineering capabilities become installable V2 workflows rather than being rebuilt as a second product architecture.

Canonical artifact hierarchy:

```text
WorkflowRepository
  ↓
Workflow
  ↓
immutable WorkflowVersion
  ↓
WorkflowIR
  ↓
WorkflowDeployment
  ↓
WorkflowRun
```

WorkflowIR is the semantic source of truth. Text, voice, demonstration traces, prompts, model memory, compiled artifacts, teaching sessions and marketplace listings are inputs/provenance/derived views, not replacement workflow formats.

Web, desktop, iOS, Android and cloud use one protocol. Nodes advertise capabilities; authorization, policy, consent, placement and trust remain separate. Locality is a correctness constraint.

## Execution proof architecture

V2 now defines an additive verifiable-execution layer:

```text
WorkflowIR
  ↓
WorkflowRun
  ↓
ExecutionStatement
  ↓
ExecutionDigest
  ↓
ExecutionAttestation
  ↓
verification/appraisal
  ↓
VerifiedExecutionFact
  ↓
ExecutionProofGraph (later)
```

The cryptographic layer does not replace WorkflowIR, Run, Node, authorization, or verification. A signature authenticates a statement; it does not automatically prove a physical side effect. Freshness, evidence sufficiency, trust and assurance are explicit.

## Mechanical execution and quality

Every V2 Work Order follows repository-resident control: dependencies → activation → deterministic verification → real-system proof → feature-boundary dogfooding → PR → sole architect merge → finalization → integration gates → cross-feature dogfooding. Parallel siblings share one stable base, own disjoint authoritative surfaces, never rebase onto each other, and never sacrifice tests, security, evidence, or dogfooding.

## V1 boundary

V2 does not silently replace frozen v1.0 authorities. Reuse occurs through explicit adapters and preserved authority boundaries.

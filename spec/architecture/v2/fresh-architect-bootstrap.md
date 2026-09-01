# WorkflowOS 2.0 — Fresh Architect / Implementation Bootstrap

This file is the shortest safe recovery path for a new LLM architect or implementation agent with zero conversation history.

## Read in this order

1. `spec/architecture/v2/V2-CTRL-000-implementation-authorization.md`
2. `spec/architecture/v2/architecture-constitution.md`
3. `spec/architecture/v2/V2-CTRL-003-protocol-registry.md` and `.json`
4. `spec/architecture/v2/execution-control-plane.md`
5. `spec/architecture/v2/V2-CTRL-001-conformance-checklist.md`
6. `spec/architecture/v2/dogfooding-protocol.md`
7. `spec/architecture/v2/V2-CTRL-002-roadmap-lock.md`
8. `spec/development-state/v2-work-order-state.json`
9. `spec/architecture/v2/architecture-change-requests/V2-ACR-001-execution-attestation.md`
10. `spec/architecture/v2/execution-attestation.md` when execution proof, trust, cryptographic evidence or cross-device coordination is in scope
11. the assigned Work Order in `spec/architecture/v2/work-orders/` and its machine-state entry
12. `docs/superpowers/specs/2026-09-01-workflowos-2-0-universal-workflow-protocol-design.md`
13. `spec/architecture/v2/workflow-teaching-and-marketplace.md`
14. `spec/architecture/v2/workflow-marketplace-economics.md` when commercial access is relevant
15. `spec/architecture/v2/mobile-device-runtime.md` when device/mobile/cross-device behavior is relevant
16. relevant existing V1 public contracts before reusing any V1 capability

## Status interpretation

V2 is **APPROVED FOR IMPLEMENTATION** but remains a **PROPOSED architecture generation** until a formal V2 architecture version is frozen through repository governance. Material V2 reinterpretation remains governed. V2-ACR-001 records the execution-attestation evolution and must be accepted into the governing repository state before V2-014/V2-015 implementation begins.

## Product definition

WorkflowOS 2.0 turns how people work with computers into reusable executable software. One universal protocol spans web, desktop, iOS, Android and cloud hosts.

## Canonical artifact hierarchy

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

WorkflowIR is the semantic source of truth. Raw demonstrations, screenshots/video, prompts, model memory, compiled artifacts and teaching sessions are not replacement workflow formats.

## Universal protocol

Protocol-visible names are governed by `V2-CTRL-003`. Nodes advertise capabilities; capability possession is never authorization. Platform differences remain explicit through capability, permission, placement, lifecycle and UX.

## Execution classes

Each step is `deterministic_api`, `agentic_computer_use`, `human`, or `subworkflow`.

## Execution attestation

Execution proof is layered:

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
    ↓
ExecutionProofGraph
```

A digest commits to canonical execution data. A signature authenticates an attester's statement. Neither alone proves a physical side effect. Freshness, identity, evidence, trust and assurance are separate. Stronger assurance (`software_signed`, `hardware_backed`, `tee_attested`, `verifiable_computation`) is optional by host/policy.

The proof graph is evidence about WorkflowRuns, not a second workflow graph or engine. Cross-device coordination must preserve Run/WorkflowVersion identity, causation and idempotency.

## Implementation control

The machine-readable state file is authoritative for V2 progress. A fresh agent must determine the next eligible wave from state and must never activate an item solely because this file says it is next.

Parallel means independently mergeable:

- same stable main base;
- disjoint authoritative surfaces;
- no sibling implementation dependency;
- no sibling rebase;
- complete tests, real-system proofs and dogfooding;
- integration Work Order when composition needs proof.

Current roadmap pointer after the execution-attestation evolution:

```text
W0  V2-001 COMPLETE
 ↓
W1  V2-002 + V2-003 + V2-004
 ↓
W2A V2-006 + V2-007 + V2-014
 ↓
W2B V2-005
 ↓
W3  IG-001 + IG-002 → V2-008
 ↓
W4  V2-009 + V2-010 + V2-011
 ↓
IG-006
 ↓
W5  V2-012 + V2-015
 ↓
W6  V2-013
```

## Mechanical loop

```text
read authorization + constitution + registry + state + Work Order
→ verify dependencies and stable base
→ activate
→ deterministic failing tests
→ implement
→ real-system verification
→ feature-boundary dogfood
→ persist findings
→ PR
→ sole architect review/merge
→ post-merge state finalization
→ integration gate when required
→ cross-feature dogfood
→ next eligible wave
```

## Non-negotiable stop conditions

Stop and raise a governed architecture change when implementation would:

- redefine a frozen V2 concept;
- create a second workflow protocol/engine;
- treat capability possession, marketplace entitlement, or a signing key as authorization;
- turn a signature/hash into automatic proof of a physical side effect;
- accept stale/replayed execution attestations;
- silently downgrade required assurance;
- make a platform-specific semantic fork;
- introduce a second evidence/verification authority;
- silently mutate an immutable WorkflowVersion;
- require an unmerged sibling implementation;
- remove/skip required proof or dogfooding;
- activate an integration gate before all required inputs are COMPLETE.

# Persistent Architecture Governance

This directory defines repository-resident governance contracts for WorkflowOS. It is not a replacement authority for architecture, Work Items, workflow, verification, review, or GitHub.

## Coexisting documents (reconciled 2026-08-29)

This directory also carries the architect's direct-to-main upload wave of 2026-08-28T18:24–18:40Z — `ARCHITECTURE_LOCK.md` ("Version: 2.0, Status: FROZEN"), `ARCHITECT_ROLE.md`, `AGENT_PROTOCOL.md`, and `NEW_ARCHITECT_START.md` — which predate the architect-issued issues #64..#73 (the v1.1 track this package carries) in authorship time and declare a parallel "2.0" roadmap under the re-used WORK-053..059 identifiers. The divergence is recorded and awaits architect reconciliation: see `spec/architecture/v1.1/reconciliation-record.md`. While v1.1 remains proposed, the JSON contracts below are PROPOSED v1.1 contracts; the architect's markdown documents remain the architect's own directives, and the frozen governing architecture remains v1.0 (`spec/architecture.md`, `spec/architecture-lock.md`, `spec/development-state/program-state.json`).

## The v1.1 proposed contracts

- `architect.json` defines who/what may make architectural and merge decisions.
- `worker-protocol.json` defines the stateless implementation-agent handoff.
- `assurance-profiles.json` defines deterministic proof depth.
- `checkpoint-contract.json` defines required checkpoint classes.
- `future-roadmap.json` records the proposed v1.1 sequence and the architect's parallel roadmap.

Authoritative precedence is: frozen ArchitectureVersion/architecture lock → owning domain authority → Work Order → derived development state → evidence summaries. When artifacts conflict, fail closed and require architect reconciliation.

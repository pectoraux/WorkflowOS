# Persistent Architecture Governance

This directory defines repository-resident governance contracts for WorkflowOS. It is not a replacement authority for architecture, Work Items, workflow, verification, review, or GitHub.

- `architect.json` defines who/what may make architectural and merge decisions.
- `worker-protocol.json` defines the stateless implementation-agent handoff.
- `assurance-profiles.json` defines deterministic proof depth.
- `checkpoint-contract.json` defines required checkpoint classes.

Authoritative precedence is: frozen ArchitectureVersion/architecture lock → owning domain authority → Work Order → derived development state → evidence summaries. When artifacts conflict, fail closed and require architect reconciliation.

# WorkflowOS Architecture v1.1

Status: proposed pending ACR-001 approval and merge.

v1.1 is an additive evolution of frozen v1.0. Historical v1.0 documents are never rewritten to make v1.1 true.

## Scope

v1.1 adds the durable architectural model for:

- Engineering Control Loop: sense → understand → plan → check → execute → verify → review → release → observe → learn.
- Complexity-adaptive assurance.
- Derived System Model and provenance-aware engineering context.
- Quality attributes and architecture fitness.
- Engineering signals from repository, CI, runtime, security, incidents, performance, user and product feedback.
- Change Programs and Change Sets for large-system evolution while retaining Work Item as the atomic governed unit.
- Continuous architecture evaluation and Architecture Change Requests.
- Operational/release governance where applicable.
- Self-hosting of WorkflowOS without permitting silent changes to governing architecture.

## Authority rule

No v1.1 artifact becomes a replacement for an existing v1.0 authority. New artifacts are classified as normative architecture, authoritative state in an existing authority, derived engineering state, or evidence.

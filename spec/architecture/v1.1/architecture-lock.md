# WorkflowOS v1.1 Architecture Lock

These are forward-evolution invariants for v1.1. They supplement rather than rewrite `spec/architecture-lock.md` v1.0.

## Authority

1. `/architecture` is the sole normative architecture authority.
2. `/work-items` is the sole Work Item and Work Order authority.
3. `/workflows` is the sole runtime workflow authority.
4. `/verification` is the sole verification/evidence authority.
5. `/reviews` is the semantic review authority.
6. `/github` is the external repository/PR/CI authority.
7. `spec/development-state/` is the repository-resident development-program state, not a replacement domain authority.

## Evolution

8. v1.0 is immutable historical architecture.
9. ACR approval is required before v1.1 becomes governing.
10. Architecture changes create a new ArchitectureVersion; no self-hosted worker may rewrite a governing version in place.

## Complexity and assurance

11. Work Item remains the atomic governed implementation unit.
12. Change Programs and Change Sets may group Work Items but may not replace Work Item authority.
13. Assurance depth is one of LIGHT, STANDARD, HIGH_ASSURANCE, CRITICAL.
14. Assurance depth changes evidence/checkpoints only; it never weakens authority, security, tenancy, provenance, identity, idempotency, concurrency, or verification semantics.
15. Unknown or unclassified risk defaults to the safer assurance floor.

## Evidence and feedback

16. Derived System Model facts retain provenance and never overwrite authoritative sources.
17. Engineering Signals are evidence-backed and advisory to planning until converted through an authorized Work Item/architecture decision.
18. Quality-attribute fitness requires explicit measurement source and threshold/baseline where a threshold is claimed.
19. Behavioral correctness and transformation completeness are separate proof classes for migrations/refactors.
20. Operational and user feedback may feed planning but cannot directly mutate architecture/workflow/review state.

## Parallel implementation

21. Each implementation agent owns one Work Item branch/PR at a time.
22. Dependency eligibility and protected-surface conflict must be established before parallel execution.
23. Workers may not alter another Work Item's authoritative scope or governance state.
24. Merge remains the architect-controlled convergence gate.

## Self-hosting

25. WorkflowOS may govern its own implementation using the same lifecycle it provides to customer systems.
26. Self-hosting cannot silently change the governing architecture or its own governance rules.
27. Loss of conversational context must not prevent reconstruction of architecture, state, dependencies, checkpoints, decisions, or worker handoff from repository artifacts.

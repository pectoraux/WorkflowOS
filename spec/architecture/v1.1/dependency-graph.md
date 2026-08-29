# WorkflowOS v1.1 Dependency Graph

The v1.1 graph supplements the frozen v1.0 dependency graph. Dependencies are authoritative only when represented in the owning Work Order/program state; this document is the design-time graph.

```text
WORK-046 + WORK-051 + WORK-052
            ↓
         WORK-053
            ↓
         WORK-054
         /     \
        ↓       ↓
    WORK-055  WORK-056
        | \     /
        |  \   /
        ↓   \ /
    WORK-058 WORK-057
        |      |
        └──┬───┘
           ↓
       WORK-059
           ↓
       WORK-060
           ↓
       WORK-061
```

Exact edges:

- WORK-053 ← WORK-046, WORK-051, WORK-052
- WORK-054 ← WORK-039, WORK-053
- WORK-055 ← WORK-053, WORK-054
- WORK-056 ← WORK-039, WORK-041, WORK-054
- WORK-057 ← WORK-053, WORK-054, WORK-046, WORK-047
- WORK-058 ← WORK-053, WORK-055, WORK-046, WORK-051, WORK-052
- WORK-059 ← WORK-055, WORK-056, WORK-058, WORK-019
- WORK-060 ← WORK-055, WORK-056, WORK-058, WORK-059, WORK-005
- WORK-061 ← WORK-057, WORK-058, WORK-059, WORK-060, WORK-047, WORK-050

Parallelization is permitted only where dependencies are complete and protected-surface coordination permits it. The graph is not itself an authorization token; derived frontier state must reconcile it with live program state and GitHub merge evidence.

> **Reconciliation note (2026-08-29):** the architect's direct-to-main upload wave
> (2026-08-28T18:24–18:40Z) re-uses the WORK-053..059 identifiers for a different
> dependency set (053←[052], 054←[053], 055←[052], 056←[053,055], 057←[053,055],
> 058←[056,057], 059←[058]) under a "2.0" label. This design-time graph follows the
> architect-issued issues #65..#73. Both tracks are recorded in
> `spec/development-state/dependency-state.json`; the identity collision awaits
> architect reconciliation — see [`reconciliation-record.md`](reconciliation-record.md).

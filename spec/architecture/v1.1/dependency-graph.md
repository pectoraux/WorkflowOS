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

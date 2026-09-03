# Z.ai Recovery Instruction

Z.ai should resume WorkflowOS from WORK-031, not from the later V2 product branch.

Baseline: `68d88c6f91dddf3bb7c371bcf468cfbb2fcd5a6b`

Preferred working branch: `work/v2-017-universal-ux-recovery`

Before coding, inspect the repository at the baseline and reconstruct the intended product roadmap from the artifacts that existed at that point. Do not force-reset `main`. Do not pull the later universal UX, benchmark, identity, or other post-WORK-031 product direction into this line without explicit reconciliation.

Preserve the existing WORK-031 Companion architecture and the shipped real-provider adapters (Z.ai, ChatGPT, Claude) unless the reconstructed product roadmap says otherwise.

The first output should be a committed product-direction reconstruction: baseline product, intended next work, later drift vs reusable infrastructure, architecture/contracts that remain relevant, and first implementation task.

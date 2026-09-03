# Z.ai Recovery Instruction

Z.ai is being asked to continue WorkflowOS product development from the last intended product checkpoint before the later product-direction divergence.

## Required baseline

- Branch: `product/recover-from-work031`
- Baseline commit: `68d88c6f91dddf3bb7c371bcf468cfbb2fcd5a6b`
- Baseline meaning: WORK-031, after the Claude Companion adapter shipped and the three real provider adapters (Z.ai, ChatGPT, Claude) were present.

## First action

Do not immediately implement new features.

First inspect the repository at the WORK-031 baseline and reconstruct the intended next product direction from the existing code, docs, commits, and work orders that were already in scope at that point.

## Do not do

- Do not force-reset `main`.
- Do not merge the later V2 consumer-product UX line into this recovery branch by default.
- Do not assume later benchmark, identity, or universal-product UX work was part of the intended product after WORK-031.
- Do not modify frozen V1 semantics.
- Do not introduce a second workflow protocol or execution authority.

## Deliverable before implementation

Produce a repository-grounded product-direction reconstruction identifying:
1. what the product was at WORK-031;
2. what the next intended Work Orders were;
3. which later changes are product-direction drift versus reusable infrastructure;
4. which later architectural contracts, if any, must be retained for compatibility;
5. the first concrete implementation task from the recovered roadmap.

Implementation should begin only after that reconstruction is committed to this branch.

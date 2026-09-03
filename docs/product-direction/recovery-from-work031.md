# Product Direction Recovery — WORK-031 Baseline

## Decision

The current `main` line contains a later V2 architecture/product direction that does not represent the intended product direction after WORK-031. We will **not rewrite or force-reset `main`**.

A separate product line, `product/recover-from-work031`, is rooted exactly at WORK-031 commit `68d88c6f91dddf3bb7c371bcf468cfbb2fcd5a6b` and is the authorized baseline for recovering the intended product direction.

## Baseline

WORK-031 is the last known product checkpoint before the later divergence. At this point the product consisted of the WorkflowOS Companion architecture with real Z.ai, ChatGPT, and Claude adapters, using the provider-neutral companion protocol and the existing WorkflowOS execution handoff boundary.

## Rules for recovery

1. Preserve the WORK-031 provider adapters and companion architecture unless a new product decision explicitly changes them.
2. Do not transplant the later V2 consumer-product shell, benchmark product, identity/product IA, or other later product assumptions onto this recovery line merely because they exist on `main`.
3. Keep the recovery line isolated from `main` until the intended product direction and compatibility plan are re-established.
4. Do not delete or rewrite the later V2 history from `main`; it remains a historical/governed line.
5. Any semantic change that crosses the WORK-031 protocol or authority boundary requires an explicit architecture decision on this product line.

## Architecture impact

This recovery line does not itself modify the existing architecture documents on `main`. It is a product-direction branch rooted before the later V2 evolution.

The current V2 constitution on `main` remains `PROPOSED / implementation-authorized`, while V1 remains frozen and authoritative for V1 behavior. Therefore this recovery decision should be treated as a product-direction fork, not as an assertion that the V2 architecture never existed.

## Z.ai continuation instruction

Use commit `68d88c6f91dddf3bb7c371bcf468cfbb2fcd5a6b` / branch `product/recover-from-work031` as the working baseline. First reconstruct the intended product roadmap from the WORK-031 state and repository evidence. Do not merge or cherry-pick later V2 product work into this line until explicitly reconciled.

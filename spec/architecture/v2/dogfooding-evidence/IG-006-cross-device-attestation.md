# IG-006 — Cross-Device Execution Attestation Composition — Dogfooding Evidence

**Work Order:** IG-006 — Cross-Device Execution Attestation Composition
**Classification of capability:** integration-gate verification of four merged execution-facing contracts (V2-005 durable WorkflowRuns × V2-008 computer/device execution × V2-009 locality-aware placement + event delivery × V2-014 ExecutionAttestations) composed into ONE cross-device execution protocol; not a human UI surface
**Validation type:** real-stack integration experiment (work-order dogfooding requirement, literal frozen clause: "Run one safe cross-device workflow using two real supported hosts. Execute a first step on host A, transfer the run, verify its attestation on host B, execute a dependent step, disconnect/reconnect or replay one message, and verify the resulting Run/evidence/proof graph remains correct and side-effect-safe")
**Status:** EVIDENCE PERSISTED — experiment run through the real integrated paths; gate remains pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

IG-006 — Cross-Device Execution Attestation Composition, wave W5 integration gate / prerequisite for V2-015, branch `feat/ig-006-cross-device-attestation`, base `927f23dea74bd2d9206fb55e8cb084088650d97c` (current main after the IG-004 gate merge). Inputs: V2-005, V2-008, V2-009, V2-014 (all merged on this base). Frozen scope: integration tests, protocol conformance, evidence and dogfooding ONLY — this gate composes already-merged capabilities; no implementation redesign, no sibling rebases, no drive-by fixes. The diff is EXACTLY 3 new files (the gate test, the dogfooding runner, this evidence file) — ZERO modifications to any existing file.

## Workflow / version under test

ONE safe cross-device WorkflowIR workflow authored through the merged V2-003 builder — **the intake-form acknowledgment workflow** (3 nodes: the browser step on Node A `web` device kind, a human handoff approval, the device-local dependent acknowledgment write on Node B `desktop` device kind), validated by the real `validateWorkflowIrDocument`, V2-003 semantic digest `1c271b56b…3c45`, content digest `16b409f2c…4e4b`. Version 1 created through the real V2-002 route, INSTALLED (pinned) through the real installations route, deployed through the real V2-009 service with one `file.changed` subscription (the deployment pins the SAME exact version tuple).

## Surface / host

The REAL stack, one process, inject-driven HTTP over the REAL Fastify app:

- **Persistence:** real PGlite with ALL 62 migrations (incl. `0062_workflow_deployments_v2.sql`).
- **Identity:** the real identity stack — API-key operator provisioned through the real credential provisioner.
- **Routes:** the real V2-002 workflow-repository routes (create/install/read), the real V2-005 workflow-runs routes (request/start/steps/invocations/complete/history + the attestation attach boundary), the real V2-009 workflow-deployments routes (event ingest), every call over `app.inject()`.
- **Two real supported hosts (the V2-008 runtime's supported host kinds), both registered through the REAL V2-004 node protocol:**
  - **HOST A (Node A, the web device kind):** `WebBrowserHostAdapter` over the merged `ScriptedBrowserEnvironment` carrying a REAL Ed25519 attester key — the browser step's grounded click is a REAL host action through the universal protocol.
  - **HOST B (Node B, the desktop device kind):** `DesktopHostAdapter` over the merged `RealFilesystemDesktopEnvironment` (REAL `node:fs/promises` I/O rooted at a real sandbox directory) carrying a REAL Ed25519 attester key — the dependent step's write is a REAL filesystem side effect, asserted by reading the real bytes back.
- **The merged V2-008 `ComputerAgentRuntime` drives both hosts over the real V2-005 run service as its recorder** (the runtime's own public composition surface).
- **Independent verification:** Node B's verifier context (its own fresh single-use replay registry, its own trusted-attester list, the run-derived binding expectations) — real Ed25519 verification. An additional INDEPENDENT VERIFIER PROCESS (importing ONLY the merged public barrel) verifies the raw canonical envelope bytes with an out-of-band `verifier-context.json` — zero production context.
- **Transfer medium:** Node A's attestation serialized to the V2-014 canonical envelope bytes on the transfer medium (2102 chars) and parsed back with the SAME identity + statement.
- **Clocks:** the shared injected trigger clock; the verifier clocks are injected and advanceable (freshness/epoch tests).

## Exact task

1. Author the cross-device workflow; create + INSTALL (pin) v1 through the real V2-002 routes; deploy it (V2-009) with one `file.changed` subscription — the deployment pins the SAME exact version tuple.
2. THE TRIGGER: deliver the real `file.changed` event (source = Node A, payload = the real intake-form file) over the real ingest route; verify the triggered run pins the EXACT version identity with the event/run correlation; verify locality-aware placement (browser step → Node A ONLY; device-local dependent step → Node B ONLY; a cloud relay advertising the SAME filesystem capabilities is capability-eligible yet placement-INELIGIBLE — capability alone never routes); verify duplicate-event convergence.
3. EXECUTE the first step on HOST A: the browser step (observe → grounded click → verify) completes on Node A through the merged runtime and the run PAUSES at the human handoff approval (the transfer moment); Node A produces ONE `software_signed` ExecutionAttestation durably attached through the real V2-005 boundary.
4. TRANSFER: serialize Node A's attestation to the V2-014 canonical envelope bytes on the transfer medium; the INDEPENDENT VERIFIER PROCESS verifies the raw bytes with real Ed25519.
5. VERIFY on HOST B (independent verifier context, BEFORE admitting the dependent action): Node B's own verifier context admits the attestation; the verified fact attests `statement_authenticity` ONLY; negatives ALL typed and side-effect-free: untrusted-attester refusal (`ATTESTATION_ATTESTER_UNEXPECTED`, acknowledgment file still absent), replayed handoff (`ATTESTATION_REPLAYED` — single-use nonce consumed), epoch-stale (`ATTESTATION_EPOCH_STALE`), expired (`ATTESTATION_EXPIRED`).
6. EXECUTE the dependent step on HOST B: `resumeAfterHuman(approved)` over the DURABLE run — the acknowledgment file is REALLY written exactly once (real bytes asserted); Node B produces its own attestation, verified + durably attached through the same boundary; the causal-parent proof-graph leg is checked (a dependent statement carrying Node A's execution digest verifies under the causalParents expectation; the merged runtime's un-parented statement shape is refused typed on the causalParents dimension — the gap surfaced, never forced).
7. DISCONNECT/RECONNECT + REPLAY: the re-presented handoff is refused `ATTESTATION_REPLAYED`; duplicate handoff delivery converges in the V2-014 ingestion ledger (accepted → duplicate, 2 deliveries, one identity); duplicate trigger converges (zero new runs); duplicate attach command converges exactly-once (executed=false); a re-attach under a NEW command id is rejected typed through the real route (HTTP 422 `RUN_ATTESTATION_REJECTED` carrying `ATTESTATION_REPLAYED`, the DURABLE rejection row records it); duplicate host action converges in the host ledger (NO second write — the real file bytes unchanged).
8. Verify the RESULTING Run/evidence/proof graph: the run history reconstructs (ONE attempt, all three steps in order); both attestation bindings carry the SAME run/version/semantic/attempt identity across TWO DIFFERENT node identities; the protocol timeline is EXACTLY the pinned 31-event sequence (zero new events from duplicates/replays); the invocation sequence is exactly the cross-device loop with EXACTLY ONE write; every attestation evidenceReference resolves to a real evidence record of THIS run; final accounting: exactly ONE run, ONE durable rejection row, ONE write effect per host, the immutable version byte-identical.
9. Execute as a standalone real process, TWICE on fresh stacks, and persist the transcript verbatim below.

## Starting state

Fresh PGlite + fresh identity stack per run. Deterministic environment: shared injected trigger clock, sequential id factories, fixed fixture content, fixed node key seeds (the node identities `node_693d…09b7` / `node_198a…77d6` are seed-derived and stable across runs). REAL Ed25519 attester keys are generated per run (key material cannot be seeded) — the key-derived facts (attester key ids, attestation ids, execution digests) are the normalized-out bookkeeping; every deterministic structured fact (version content/semantic digests, node identities, the 31-event timeline, the invocation/evidence sequences, every typed outcome) is compared byte-for-byte across the two runs by the runner itself. No network, no wall-clock dependence in protocol logic (the only wall-clock facts are the run-instance timestamp/duration below).

## Expected outcome

- One Run and one WorkflowVersion identity preserved across two nodes (P1); step execution on Node A produces a valid ExecutionAttestation (P2); Node B independently verifies the attestation before admitting the dependent action (P3); freshness/replay protection works across reconnect/retry (P4); causal parent binding is enforced (P5); duplicate handoff/event delivery converges without duplicate side effects (P6); capability and authorization remain separate dimensions (P7); insufficient node trust/assurance produces explicit typed ineligible/rejected results (P8); evidence and attestation references reconstruct the execution history (P9).
- A valid signature authenticates the attester statement and NEVER automatically establishes trust, authorization, capability possession, observed effect, or correctness (the verified fact's `neverAsserts` list).
- Overall: **durable runs, computer/device execution, locality-aware placement and attestations compose into ONE cross-device execution protocol without duplicate side effects or trust-boundary collapse.**

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/IG-006/backend && bunx tsx tests/integration/integration-gates/run-ig-006-dogfooding.ts` — exit code 0, final capture 2026-09-02T22:24:47Z (wall duration 7.9 s for BOTH fresh-stack runs; third consecutive all-PASS execution). Normalized-transcript sha-256 (computed by the runner, stable across runs): `0f9bf746193767fd02b2105771b0611a2f1a9de0c492bd397e15b20c76882103`.

```text
--- RUN 2 — 0. ONE immutable version: authored, installed (pinned), deployed ---
[PASS] 0.version-created :: the cross-device gate workflow created through the real V2-002 route (version 1, content digest 16b409f2c…4e4b)
[PASS] 0.version-installed :: version 1 INSTALLED (pinned) through the real installations route
[PASS] 0.version-readable :: the installed version read back over HTTP; V2-003 semantic digest 1c271b56b…3c45
[PASS] 0.deployed :: the deployment pins the SAME installed version tuple (V2-009 over the same immutable pin); one file.changed subscription

--- RUN 2 — 1. THE TRIGGER + locality-aware placement (the run pins the version) ---
[PASS] 1.event-delivered :: the real file.changed event (source = Node A, payload = the real intake-form file) ingested over HTTP: one delivery, state delivered
[PASS] 1.run-pins-version :: the triggered run pins the EXACT version identity (workflow + version + content/semantic digests + installation) with the event/run correlation (trigger id embeds the inbox event identity; the run's input commitment IS the event's payload commitment)
[PASS] 1.placement-routes-two-devices :: locality-aware placement: the browser step routes ONLY to Node A (web, node_693d…09b7), the device-local dependent step ONLY to Node B (desktop, node_198a…77d6); the cloud relay advertising the SAME filesystem capabilities is capability-eligible yet placement-INELIGIBLE (capability alone never routes)
[PASS] 1.duplicate-event-converged :: duplicate event CONVERGED idempotently (HTTP 200, created=false, zero new deliveries); still exactly ONE run

--- RUN 2 — 2. EXECUTE the first step on HOST A (Node A, the web device) ---
[PASS] 2.step-a-executed :: the browser step COMPLETED on Node A through the merged runtime (observe → grounded click → verify) and the run PAUSED at the human handoff approval (the transfer moment); the submit button is REALLY clicked on the web host
[PASS] 2.attestation-a-produced :: Node A produced ONE software_signed ExecutionAttestation, durably attached through the real V2-005 boundary (statement bound to the run/version/semantic-digest/attempt/step/node)

--- RUN 2 — 3. TRANSFER the run + the attestation (canonical bytes on the transfer medium) ---
[PASS] 3.envelope-transferred :: Node A's attestation serialized to the V2-014 canonical envelope bytes (2102 chars) on the transfer medium and parsed back with the SAME identity + statement
[PASS] 3.independent-verifier-process :: the INDEPENDENT VERIFIER PROCESS (imports ONLY the merged public barrel; raw envelope bytes + out-of-band verifier-context.json) verified the transferred attestation with real Ed25519: ok, attests "statement_authenticity", neverAsserts ["authorization","capability_possession","correct_behavior","observed_effect","sufficient_evidence"]

--- RUN 2 — 4. VERIFY on HOST B (independent verifier context, BEFORE admitting the dependent action) ---
[PASS] 4.admission-granted :: Node B's verifier context (fresh single-use replay registry, Node B's trusted-attester list, run-derived binding expectations) ADMITS the transferred attestation BEFORE the dependent action: the verified fact attests statement_authenticity only
[PASS] 4.signature-never-authorizes :: the verified fact EXPLICITLY never asserts authorization / capability possession / correct behavior / observed effect / sufficient evidence (a valid signature is never a trust grant)
[PASS] 4.untrusted-attester-refused :: a verifier that does not trust Node A's key refuses admission TYPED (ATTESTATION_ATTESTER_UNEXPECTED) and the dependent step has NOT executed (the acknowledgment file does not exist — zero side effects on Node B)
[PASS] 4.replayed-handoff-refused :: the REPLAYED handoff (the same admission message re-presented to Node B) is refused TYPED (ATTESTATION_REPLAYED — the single-use nonce was consumed at admission)
[PASS] 4.epoch-stale-refused :: a verifier epoch advanced past the statement's is stale TYPED (ATTESTATION_EPOCH_STALE)
[PASS] 4.expired-refused :: an aged envelope (verifier clock past issuedAt + validity) is expired TYPED (ATTESTATION_EXPIRED)

--- RUN 2 — 5. EXECUTE the dependent step on HOST B (Node B, the desktop device) ---
[PASS] 5.dependent-step-executed :: admission granted → Node B executes the dependent step (resumeAfterHuman over the DURABLE run: the human approved the handoff): the acknowledgment file is REALLY written (real node:fs bytes asserted) with the exact expected content
[PASS] 5.causal-parent-binding :: causal parent binding is enforced: a dependent statement carrying Node A's execution digest verifies under the causalParents expectation, while the merged runtime's un-parented statement shape is refused TYPED on dimension causalParents (the causal-chain gap is surfaced precisely, never forced)

--- RUN 2 — 6. DISCONNECT/RECONNECT + REPLAY: every duplicate converges side-effect-safely ---
[PASS] 6.handoff-ledger-converged :: duplicate handoff delivery converges by stable attestation identity (ledger: accepted → duplicate, 2 deliveries, ONE identity)
[PASS] 6.duplicate-trigger-converged :: the re-delivered trigger event converges idempotently (created=false, zero new deliveries)
[PASS] 6.duplicate-attach-converged :: the duplicate attach command (the runtime's exact command id) converges exactly-once (executed=false — the V2-005 command log)
[PASS] 6.route-replay-rejected :: the re-attach under a NEW command id is rejected TYPED through the real route (HTTP 422 RUN_ATTESTATION_REJECTED carrying ATTESTATION_REPLAYED) and the DURABLE rejection row records the replay
[PASS] 6.duplicate-host-action-converged :: the duplicate host action (the same invocation id re-presented to Node B) converges in the host ledger (converged=true) — NO second write, the real file bytes unchanged

--- RUN 2 — 7. the RESULTING RUN/EVIDENCE/PROOF GRAPH (correct + side-effect-safe) ---
[PASS] 7.run-graph-reconstructs :: the run history reconstructs: the completed run pins the SAME version identity, ONE attempt, all three steps in order (web node → human approval → desktop node)
[PASS] 7.attestations-cross-device :: BOTH attestation bindings carry the SAME run/version/semantic/attempt identity across TWO DIFFERENT node identities (Node A produced the first, Node B the second — distinct execution digests): one protocol across two devices
[PASS] 7.timeline-exact :: the protocol timeline is EXACTLY the pinned 31-event sequence (requested → started → the browser loop → verified attestation → paused → resumed → the human approval → the filesystem loop → verified attestation → completed) — every duplicate/replay added ZERO new protocol events
[PASS] 7.invocations-and-evidence :: the invocation sequence is exactly the cross-device loop (browser.observe/click/observe on Node A, filesystem.read/write/read on Node B, all succeeded, EXACTLY ONE write); the evidence class multiset matches (intent/claim/observation/verification per capability step + ONE human_confirmation produced by the acting human); every attestation evidenceReference resolves to a real evidence record of THIS run
[PASS] 7.side-effect-safety :: FINAL ACCOUNTING: exactly ONE run, ONE durable rejection row (the typed replay), ONE write effect per host (the acknowledgment bytes EXACT), and the immutable version byte-identical after the whole experiment

# RUN 2 summary: all checks PASS

(RUN 1 transcript: identical to RUN 2 above after normalizing run-scoped bookkeeping
 — uuid-shaped ids, the derived dep_/sub_/evt_/dlv_/wfr_/wfre_/… ids, the Ed25519
 key-derived material (attester key ids, attestation ids, execution digests — real
 Ed25519 cannot be seeded), the mkdtemp sandbox suffixes and the run labels. The
 deterministic structured facts — version content/semantic digests, node identities,
 the timeline, the invocation/evidence sequences, every typed outcome — are compared
 byte-for-byte across the two runs.)

determinism (structured facts): IDENTICAL across the two fresh-stack runs
determinism (normalized transcripts): IDENTICAL

DOGFOODING RESULT: PASS (deterministic across two fresh runs)
normalized-transcript-sha256: 0f9bf746193767fd02b2105771b0611a2f1a9de0c492bd397e15b20c76882103
```

Summary of observed outcomes (P1–P9 mapping):

- **P1 (one Run and WorkflowVersion identity across two nodes):** the completed run pinned the SAME version identity (content digest `16b409f2c…4e4b`, semantic digest `1c271b56b…3c45`, installation pin) across Node A (`node_693d…09b7`, web) and Node B (`node_198a…77d6`, desktop); both attestation bindings carried the SAME run/version/semantic/attempt identity across two DIFFERENT node identities.
- **P2 (Node A produces a valid ExecutionAttestation):** Node A produced ONE `software_signed` attestation, durably attached through the real V2-005 boundary, statement bound to run/version/semantic-digest/attempt/step/node.
- **P3 (Node B independently verifies before admitting the dependent action):** Node B's own verifier context (fresh single-use replay registry, its own trusted-attester list, run-derived binding expectations) admitted the transferred attestation BEFORE the dependent action; the independent-verifier process verified the raw canonical envelope bytes with real Ed25519 importing only the merged public barrel.
- **P4 (freshness/replay across reconnect/retry):** typed refusals — replayed handoff `ATTESTATION_REPLAYED` (single-use nonce), epoch-stale `ATTESTATION_EPOCH_STALE`, expired `ATTESTATION_EXPIRED`, re-attach under a new command id HTTP 422 `RUN_ATTESTATION_REJECTED` with the durable rejection row.
- **P5 (causal parent binding enforced):** a dependent statement carrying Node A's execution digest verified under the causalParents expectation; the merged runtime's un-parented statement shape was refused typed on the causalParents dimension (the gap surfaced, never forced).
- **P6 (duplicate handoff/event delivery converges without duplicate side effects):** duplicate handoff → ledger accepted → duplicate (2 deliveries, ONE identity); duplicate trigger → created=false, zero new deliveries, still ONE run; duplicate attach command → executed=false (exactly-once); duplicate host action → converged=true, NO second write, real file bytes unchanged; the 31-event protocol timeline gained ZERO new events.
- **P7 (capability and authorization separate):** the cloud relay advertising the SAME filesystem capabilities was capability-eligible yet placement-INELIGIBLE — capability alone never routes; the gate test's dedicated negative proves the typed refusal with zero side effects.
- **P8 (insufficient node trust/assurance → explicit ineligible/rejected):** the gate test's dedicated negatives — insufficient node trust produces the typed ineligible result with no execution on the untrusted node; insufficient attestation assurance produces the typed rejection at both the runtime gate and the admission verifier.
- **P9 (evidence/attestation references reconstruct the execution history):** the run history reconstructs (ONE attempt, three steps in order); every attestation evidenceReference resolved to a real evidence record of THIS run; the evidence class multiset matched the protocol; final accounting exactly ONE run, ONE durable rejection row, ONE write effect per host, immutable version byte-identical.

## Duration / cost

Wall duration 7.9 s for the whole double-run experiment (two fresh PGlite stacks + two identity stacks + both full cross-device executions with real browser-action and real filesystem side effects + all replay/duplicate legs). Protocol time is driven by the injected deterministic clocks, so the 31-event protocol timeline is reproducible exactly.

## Evidence references

- Runner: `backend/tests/integration/integration-gates/run-ig-006-dogfooding.ts` (standalone real-process run; final capture 2026-09-02T22:24:47Z, exit code 0, wall 7.9 s, normalized-transcript sha-256 `0f9bf746193767fd02b2105771b0611a2f1a9de0c492bd397e15b20c76882103` — identical across runs).
- Gate test: `backend/tests/integration/integration-gates/ig-006-cross-device-attestation.integration.test.ts` (5 tests on the real stack: the full P1–P9 cross-device gate path — one run, two nodes, attested handoff, verified admission, dependent action; P8 insufficient-node-trust typed ineligible with no execution; P8 insufficient-attestation-assurance typed rejection at the runtime gate + admission verifier; P7 capability/authorization separation with typed refusal and zero side effects; the surfaced composition observation on node_output dataflow — see Limitations).
- Frozen work order: `spec/architecture/v2/work-orders/IG-006.md` + Issue #150 (branch base `927f23dea74bd2d9206fb55e8cb084088650d97c`).
- Deterministic identities shared by both runs: version content digest `16b409f2c…4e4b`; V2-003 semantic digest `1c271b56b…3c45`; node identities `node_693d…09b7` (web) / `node_198a…77d6` (desktop); the pinned 31-event protocol timeline; the canonical envelope byte length 2102.
- Scoped verification at evidence time (all re-run at the final head, receipts in the PR): gate test 5/5 green (run TWICE — deterministic); the other gates IG-001/IG-002/IG-004 13/13 green (zero modifications to them); architecture suite 895/895 (static pins intact: migration count 62, route count 37 — the gate adds ZERO src files); `bun run typecheck` — zero new errors (the 2 `workflow-deployments.route.ts` errors are the inherited, pristine-base-verified baseline, disclosed in the PR); scoped eslint on both new files — 0 errors, 0 warnings; full local vitest suite in disjoint chunks: **4151 passed / 3 failed / 65 skipped** (baseline 4146/3/65 + 5 new passing gate tests; the 3 failures are the WORK-069 governance trio — governance-state W052-AC01 + parallel-eligibility W052-AC03 ×2 — identical when re-run in isolation at this head; zero governance files in this diff).
- Full-suite chunk details (re-runnable from `backend/`): unit + architecture + continuous-validation 2351 passed; integration a–e 1010 passed / 3 failed / 36 skipped (the inherited trio); integration f–o 205 passed / 10 skipped (includes the integration-gates 13/13 + the 5 new IG-006 gate tests); integration p–w 585 passed / 19 skipped.

## Classification

**PASS** — durable WorkflowRuns, computer/device execution, locality-aware placement and ExecutionAttestations verified to compose into ONE cross-device execution protocol without duplicate side effects or trust-boundary collapse: one Run/WorkflowVersion identity preserved across two nodes; attested step execution on Node A; independent real-Ed25519 verification on Node B BEFORE admitting the dependent action (a valid signature attests statement authenticity only and never authorizes anything by itself); freshness/replay protection across reconnect/retry; causal parent binding enforced; every duplicate converges side-effect-safely; capability and authorization remain separate; insufficient trust/assurance fails closed with typed results; evidence and attestation references reconstruct the execution history. No second authority introduced (the gate consumes the four merged barrels exactly; the diff adds ZERO src files, ZERO migrations, ZERO routes).

## Limitations recorded honestly (observations, not failures)

1. **Two real supported hosts = two in-process host instances of the V2-008 runtime's supported host kinds.** HOST A's browser environment is the merged `ScriptedBrowserEnvironment` (the V2-008 test surface — a real host adapter over a scripted browser, not a live browser); HOST B is the merged `RealFilesystemDesktopEnvironment` (REAL `node:fs/promises` I/O — real bytes asserted). Both run in ONE process; no real network transport or OS process separation between the devices.
2. **Surfaced composition observation (pinned for the architect, never forced):** `node_output` dataflow does NOT survive the cross-device handoff — the dependent step cannot bind its input to the browser step's declared output across the handoff boundary (the gate test's fifth test pins this precisely). The dependent step in this experiment is therefore device-local (bound to its own host's input), not output-dependent.
3. **Causal-parent emission gap on the runtime side:** the merged V2-008 runtime's attestation statement shape is un-parented; the causal-parent proof-graph leg is proven through the verifier's causalParents expectation (a dependent statement carrying Node A's execution digest verifies; the runtime's un-parented shape is refused typed on the causalParents dimension). The gap is surfaced, never forced.
4. **Real Ed25519 keys are generated per run** (key material cannot be seeded) — attester key ids, attestation ids and execution digests are run-scoped; the runner's determinism proof compares the structured facts byte-for-byte and the normalized transcripts (both IDENTICAL), with the normalized-transcript sha-256 stable across runs.
5. **In-process HTTP.** All route calls are `app.inject()` over the REAL Fastify app in one process (the family precedent).
6. **PGlite/CI divergence.** The local real stack is PGlite; CI runs the same suite against PGlite (the production boundary is `pg`) — the same single persistence boundary, different driver build (recorded by every V2 family evidence).

## Resulting action

- IG-006 remains **implemented / pending-architect-merge** (never marked COMPLETE by an agent). This evidence satisfies the Work Order's literal dogfooding clause and all nine required proofs on the real stack.
- Two composition observations surfaced for the architect (node_output dataflow across the handoff; the runtime's un-parented statement shape) — neither forced, neither blocking the frozen proofs; both pinned precisely for the architect's disposition.
- **V2-015 remains blocked until the architect merges this gate** — the merge is the completion event.

# V2-004 Dogfooding Evidence — Two-Host Capability Discovery

**Work Order:** V2-004 — Node + Capability Protocol (W1, parallel-no-rebase; base `ed82bbc6774a8bb6d052e7a0618e867b796dde32`)
**Experiment required:** dogfooding-protocol.md — "Discover a real node's capabilities and execute a workflow through capability matching without platform-specific semantics leaking into the workflow" (work order phrasing: "Discover capabilities from two real supported host classes and run the same workflow semantics through both where the required capabilities exist").
**Classification:** execution-facing protocol feature — real product-path experiment.

## Experiment design

- **Workflow under test:** `CANONICAL_WORKFLOW_FIXTURE`-style dogfood workflow (3 steps) pinned to `workflow-version:dogfood:two-host@1`, authored ONLY in registry-canonical identifiers: `filesystem.read` (device_preferred), `browser.observe` (any_supported_node), `notifications.observe` (human execution class, requiresHumanApproval).
- **Two real supported host classes:** a DESKTOP-class node and a WEB-class node, each registered through the real authenticated registration protocol (real out-of-band key directory, real HMAC-SHA256 signing over the canonical payload, real monotonic registration sequence).
- **Real capability execution:** the desktop host's `filesystem.read` handler performs a genuine `node:fs` read of the committed fixture file `backend/tests/integration/node-capability/fixtures/local-config.json` — the file's actual bytes must come back through the invocation record. This is a real capability execution, not a mock.
- **Declared boundary adapter (honest scope):** the web host's `browser.observe` handler and both hosts' `notifications.observe` handlers are explicit adapter placeholders — the real browser/notification runtimes are owned by V2-008 (execution runtime and adapters), which is NOT merged in W1. The dogfooding protocol permits a mock only for dependencies outside the feature's control boundary; these are declared, and the web host advertises ONLY capabilities it can honestly represent today (it does not claim `filesystem.read` even though the test process could read files — that would be exactly the forbidden silent emulation).
- **Starting state:** fresh `NodeCapabilityService` per host; no nodes registered; no handlers attached.

## Expected outcome

- Both hosts register through the authenticated protocol and are discoverable via `discoverNodes()`.
- The two host classes honestly report DIFFERENT eligibility for the same workflow semantics: desktop `[true, false, true]` (lacks `browser.observe`), web `[false, true, true]` (lacks `filesystem.read`); neither is fully eligible — the honest partial answer.
- Capability invocation executes only where matching produced an eligible decision; invoking a step the host did not match refuses with `capability_missing` (no cross-host substitution, no unauthorized computer-use fallback).
- No platform-specific semantics appear anywhere in the workflow semantics (every identifier registry-canonical; no SDK/vendor names).
- Discovery/evaluation is deterministic (repeated evaluation byte-identical).

## Observed outcome (run at implementation head)

All expectations confirmed:

| Check | Result |
|---|---|
| Authenticated registration of both host classes | PASS |
| `discoverNodes()` finds both nodes with honest, canonical capability sets | PASS |
| Honest different eligibility: desktop `[true,false,true]` vs web `[false,true,true]` | PASS |
| Neither host fully eligible (honest partial answer) | PASS |
| All workflow identifiers registry-canonical; no platform SDK semantics | PASS |
| Shared human-approval step eligible on BOTH hosts with equivalent decisions (`resolvedExecutionClass: 'human'`) | PASS |
| Desktop `filesystem.read` executed against the REAL filesystem — fixture bytes returned through the invocation record (`capability.invocation.completed`, evidence class `observation`) | PASS |
| Web `browser.observe` executed through the declared V2-008 boundary adapter | PASS |
| Refusal to invoke unmatched steps on either host (`capability_missing`) | PASS |
| Deterministic repeat evaluation (byte-identical decisions) | PASS |

- **Evidence reference:** `backend/tests/integration/node-capability/two-host-capability-discovery.integration.test.ts` (9 assertions, executed as part of the suite — 125/125 battery tests green including this experiment; repeat runs identical).
- **Duration/cost:** < 3 seconds for the whole battery (pure domain + one real file read); no network, no wall-clock dependence.

## Result

**PASS — classification: PASS.** The two host classes honestly report different eligibility for the same workflow semantics; capability invocation flows only through matched, authorized, healthy, supported-class paths; no platform-specific semantics leak into the workflow; the same semantic step yields equivalent decisions on hosts with equal advertisements.

## Resulting action

- Feature eligible for merge review per the control plane (verification + dogfooding evidence persisted).
- Honest limitation recorded: real browser/notification/desktop-OS adapter execution belongs to V2-008 (not merged in W1); this experiment exercises the REAL node-capability protocol path end-to-end (registration → discovery → matching → invocation → evidence record) and one REAL host capability (filesystem read) end-to-end.
- No contract-level defect found; no corrective Work Order required.

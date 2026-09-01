# V2-003 Dogfooding Evidence — Real Workflow IR Round-Trip

**Work Order:** V2-003 — Workflow IR
**Experiment (protocol row V2-003):** "Author a real workflow, serialize to IR, deserialize, and execute/inspect it for semantic equivalence."
**Classification:** feature-boundary dogfooding on the W1 semantic surface
**Date:** 2026-09-01
**Status:** PASS — evidence persisted before completion

## Work order / workflow under test

- Work Order `V2-003` (branch `work/v2-003-workflow-ir`).
- Workflow under test: **"weekly customer-report packaging"** — a real authored
  procedure a person actually wants (read the weekly CRM engagement export →
  draft the weekly summary → human approval gate → urgent/standard routing →
  portal upload or team notification → archival subworkflow → done, with an
  explicit failure end).
- The workflow exercises every semantic region the IR schema owns: all four
  execution classes (`deterministic_api` ×3, `agentic_computer_use`, `human`
  approval, `subworkflow`), all six control-edge kinds (`on_success`,
  `on_failure`, `on_approval`, `on_rejection`, `on_case`, `on_default`),
  failure retry policy, pause-safe steps, a failure-outcome end node, typed
  data ports (`string`, `object_ref`, `secret_ref`, `json`, `list<string>`),
  workflow inputs/outputs, literals, fan-out, an opaque secret reference, an
  explicit subworkflow dependency, capability requirements and placement
  constraints with a disallowed locality.

## Surface / host

The real product path for WorkflowOS 2.0 semantic operations in Wave 1: the
WorkflowIR domain's public API (`backend/src/workflow-ir/index.ts`) —
`validateWorkflowIR`, `serializeWorkflowIR`, `deserializeWorkflowIR`,
`computeWorkflowIRDigest`, `workflowIRsAreSemanticallyEqual` — executed by
Bun 1.3.14 (linux x86_64) through the repository's vitest runtime. No mock,
stub or test-only seam is introduced.

Execution (WorkflowRun) is owned by V2-005/V2-008, neither merged in W1, so
the protocol wording "execute/inspect" is satisfied by its inspection half
only — stated honestly here; no mock executor was invented (that would be a
second workflow engine, a constitutional violation).

## Exact task

1. AUTHOR the real workflow above (deliberately in non-canonical presentation:
   shuffled node/edge/binding arrays, unsorted derived-capability set).
2. SERIALIZE it to canonical WorkflowIR bytes.
3. DESERIALIZE those bytes back through the strict wire parser.
4. INSPECT the reconstructed IR node-by-node, edge-by-edge and
   binding-by-binding against the authored intent, for both user-visible
   meaning (every instruction survives byte-identically) and executable
   meaning (control/data semantics, capability requirements, placement,
   failure policy, secret opacity).

## Starting state

Fresh repository checkout at the Wave-1 base plus the V2-003 branch; no prior
WorkflowIR artifacts; the workflow authored directly as a plain JavaScript
value (the same authoring path any V2 client would take — there is no other
format to convert from, by the "no second workflow format" invariant).

## Expected outcome

- The authored workflow validates as WorkflowIR.
- Serialization is deterministic canonical JSON (no inter-token whitespace,
  sorted keys, sorted declared sets, defaults omitted).
- Deserialization reconstructs semantically identical meaning; a second
  serialize pass is byte-identical to the first (round-trip identity).
- Every instruction and every construct survives with unchanged semantics.
- The secret (`api_token`) stays an opaque `secret_ref` reference — no secret
  material ever appears in the bytes.
- The semantic digest is stable across repeated computation and across a
  second independent authoring pass with different presentation.

## Observed outcome (all expected)

- Validated: 10 nodes, 11 control edges, 11 data bindings, 5 workflow inputs,
  1 workflow output.
- Canonical serialization: **4,899 bytes**, deterministic; repeated runs and a
  second independent authoring pass (fresh object graph, reversed arrays)
  produce byte-identical output.
- Round trip: `deserialize(serialize(ir))` re-serializes to the identical
  4,899 bytes; re-validating the canonical form is a fixed point.
- Semantic digest (SHA-256 of the canonical bytes, per V2-CTRL-003):
  `43138b82ee979d1ef71a851d50c7382a7db604b3e5e809778d8e86f0c9720c53`,
  identical before/after the round trip.
- All six instructions survived byte-identically (user-visible meaning
  unchanged); all four execution classes, the approval gate
  (`on_approval`/`on_rejection` pair), the decision (`on_case` `urgent` +
  `on_default`), failure policies (`retry: 1`), pause-safe flags, the failure
  end node, the subworkflow dependency (`wf-archival@v3`) and the typed
  interface survived with unchanged semantics.
- The secret input appears only as `{"id":"api_token","type":"secret_ref"}`;
  the canonical bytes contain no secret material (checked for the fake
  credential, `ghp_`, `password`, `secret_material`).
- Cost: ~1 ms per full validate→serialize→deserialize cycle on this host
  (100 round trips ≈ 102 ms).

## Evidence references

- Executable experiment: `backend/tests/workflow-ir/ir-dogfood.test.ts`
  (steps 1–3 + the inspection matrix; part of the committed battery, green on
  the final head).
- Authoring fixture: `backend/tests/workflow-ir/fixtures.ts`
  (`realWeeklyReportIr`).
- Discrimination backing: `ir-digest.test.ts` (21 semantic mutations produce
  pairwise-distinct digests — semantically different workflows do not collapse
  to one digest), `ir-equivalence.test.ts` (two independently authored
  presentations of the same semantics converge on identical bytes + digest),
  `ir-roundtrip.test.ts`, `ir-secrets.test.ts`.

## Failure classification

**PASS** — no contract failure, no UX failure, no operational failure
encountered. One honest boundary observation (not a defect): the "execute"
half of the protocol row is not exercisable in W1 because the execution
runtime is a later Work Order; it is explicitly represented by inspection
only, and no mock executor was added.

## Resulting action

V2-003's feature-boundary dogfooding requirement is satisfied and recorded;
the Work Order may proceed to review/merge on this evidence. Downstream
consumers (V2-007 compiler, IG-001/IG-002 integration gates) consume the
recorded digest discipline (`SHA-256(canonical-json(semantic-object))`) and
the canonicalization contract proven here.

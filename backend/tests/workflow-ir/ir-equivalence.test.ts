import { describe, it, expect } from 'vitest';
import {
  serializeWorkflowIR,
  deserializeWorkflowIR,
  computeWorkflowIRDigest,
  workflowIRsAreSemanticallyEqual,
} from '../../src/workflow-ir/index.js';
import type { DeepMutableWorkflowIR } from '../../src/workflow-ir/index.js';
import { minimalIr, realWeeklyReportIr } from './fixtures.js';

/**
 * V2-003 — semantic-equivalence discrimination tests.
 *
 * Work Order mapping ("Required regressions" → "semantic equivalence across
 * clients"; registry → cross-client interoperability):
 *
 * Two independently authored representations of the same workflow semantics
 * (different array orders, different key orders, explicit defaults, escaped
 * vs literal unicode) canonicalize to byte-identical serialization and the
 * same semantic digest — the "two clients" convergence property.
 *
 * Equivalence is DEFINED by the IR schema contract as canonical-form
 * equality: local identifiers (node ids, port ids, case ids) are canonical
 * anchors — renaming them is a different canonical document (isomorphic, not
 * identical), and decision case order is semantic.
 *
 * The negative side (semantically different workflows must never collapse to
 * one digest) is the discrimination matrix in ir-digest.test.ts.
 */
describe('WorkflowIR semantic equivalence across clients', () => {
  it('two clients authoring the same semantics converge on identical bytes + digest', () => {
    // "Client A" — the authored fixture (non-canonical array order).
    const clientA = realWeeklyReportIr();
    // "Client B" — same semantics, different presentation choices.
    const clientB = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
    clientB.nodes = [...clientB.nodes].reverse();
    clientB.edges = [...clientB.edges].reverse();
    clientB.dataBindings = [...clientB.dataBindings].sort(
      (a, b) => JSON.stringify(a.target).localeCompare(JSON.stringify(b.target)),
    );
    clientB.inputs = [...clientB.inputs].reverse();
    clientB.outputs = [...clientB.outputs].reverse();
    clientB.dependencies = [...clientB.dependencies].reverse();
    clientB.requirements = {
      ...clientB.requirements,
      capabilities: [...clientB.requirements.capabilities].sort().reverse(),
    };
    clientB.provenance = {
      ...clientB.provenance,
      sourceReferences: [...(clientB.provenance.sourceReferences ?? [])].reverse(),
    };
    // client B also states every optional default explicitly (approval steps
    // must not state a failure policy at all — approval outcomes are
    // decisions, not retries — so their explicit default is the field's
    // absence)
    clientB.nodes = clientB.nodes.map((n) => {
      if (n.kind !== 'step') return n;
      const stated = {
        ...n,
        pauseSafe: n.pauseSafe ?? false,
        requestApproval: n.requestApproval ?? false,
      };
      if (n.requestApproval === true) return stated;
      return { ...stated, failure: n.failure ?? { retry: 0 } };
    });

    const textA = serializeWorkflowIR(clientA);
    const textB = serializeWorkflowIR(clientB);
    expect(textB).toBe(textA);
    expect(computeWorkflowIRDigest(clientB)).toBe(computeWorkflowIRDigest(clientA));
    expect(workflowIRsAreSemanticallyEqual(clientA, clientB)).toBe(true);
  });

  it('a serialized document round-trips through an independent client byte-identically', () => {
    // client A serializes; client B (a fresh deserialize call) re-serializes
    const textA = serializeWorkflowIR(realWeeklyReportIr());
    const clientB = deserializeWorkflowIR(textA);
    const textB = serializeWorkflowIR(clientB);
    expect(textB).toBe(textA);
    // and a third client agrees
    const textC = serializeWorkflowIR(deserializeWorkflowIR(textB));
    expect(textC).toBe(textA);
  });

  it('equivalence holds for the minimal workflow across presentation forms', () => {
    const compact = JSON.stringify(minimalIr());
    const pretty = JSON.stringify(minimalIr(), null, 4);
    const reversedArrays = JSON.stringify(minimalIr(), (key, value) =>
      key === 'nodes' || key === 'edges' ? [...(value as unknown[])].reverse() : value,
    );
    expect(workflowIRsAreSemanticallyEqual(JSON.parse(compact), minimalIr())).toBe(true);
    expect(workflowIRsAreSemanticallyEqual(JSON.parse(pretty), minimalIr())).toBe(true);
    expect(workflowIRsAreSemanticallyEqual(JSON.parse(reversedArrays), minimalIr())).toBe(
      true,
    );
  });

  describe('non-equivalence discrimination (no false convergence)', () => {
    it('renaming a node id is a different canonical identity (isomorphic ≠ identical)', () => {
      const renamed = structuredClone(minimalIr()) as DeepMutableWorkflowIR;
      const step = renamed.nodes.find((n) => n.kind === 'step');
      if (step && step.kind === 'step') step.id = 'perform_work';
      renamed.edges = renamed.edges.map((e) => ({
        ...e,
        from: e.from === 'do_work' ? 'perform_work' : e.from,
        to: e.to === 'do_work' ? 'perform_work' : e.to,
      }));
      expect(workflowIRsAreSemanticallyEqual(renamed, minimalIr())).toBe(false);
      expect(computeWorkflowIRDigest(renamed)).not.toBe(computeWorkflowIRDigest(minimalIr()));
    });

    it('changing one instruction is not equivalence', () => {
      const changed = structuredClone(minimalIr()) as DeepMutableWorkflowIR;
      const step = changed.nodes.find((n) => n.kind === 'step');
      if (step && step.kind === 'step') step.instruction = 'Perform a different unit of work.';
      expect(workflowIRsAreSemanticallyEqual(changed, minimalIr())).toBe(false);
    });

    it('reordering decision cases is not equivalence', () => {
      const a = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
      const b = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
      const addCase = (doc: DeepMutableWorkflowIR, second: 'second' | 'other') => {
        for (const node of doc.nodes) {
          if (node.kind === 'decision') {
            node.cases = [
              { id: 'urgent', condition: { kind: 'equals', value: 'urgent' } },
              { id: second, condition: { kind: 'exists' } },
            ];
          }
        }
        doc.edges = [
          ...doc.edges.filter((e) => e.kind !== 'on_case' && e.kind !== 'on_default'),
          { from: 'recipient_check', to: 'notify_team', kind: 'on_case', case: 'urgent' },
          { from: 'recipient_check', to: 'upload_report', kind: 'on_case', case: second },
          { from: 'recipient_check', to: 'archive_run', kind: 'on_default' },
        ];
      };
      // same case SET, same wiring, different evaluation order
      addCase(a, 'second');
      for (const node of b.nodes) {
        if (node.kind === 'decision') {
          node.cases = [
            { id: 'other', condition: { kind: 'exists' } },
            { id: 'urgent', condition: { kind: 'equals', value: 'urgent' } },
          ];
        }
      }
      b.edges = [
        ...b.edges.filter((e) => e.kind !== 'on_case' && e.kind !== 'on_default'),
        { from: 'recipient_check', to: 'upload_report', kind: 'on_case', case: 'other' },
        { from: 'recipient_check', to: 'notify_team', kind: 'on_case', case: 'urgent' },
        { from: 'recipient_check', to: 'archive_run', kind: 'on_default' },
      ];
      expect(workflowIRsAreSemanticallyEqual(a, b)).toBe(false);
      expect(computeWorkflowIRDigest(a)).not.toBe(computeWorkflowIRDigest(b));
    });

    it('different capability requirements are not equivalence', () => {
      const changed = structuredClone(minimalIr()) as DeepMutableWorkflowIR;
      const step = changed.nodes.find((n) => n.kind === 'step');
      if (step && step.kind === 'step') step.capability = 'filesystem.write';
      // keep the authored requirement set in agreement (a disagreeing set is
      // INVALID_FIELD by schema — the discrimination here is the capability
      // semantics, not the disagreement error)
      changed.requirements = {
        ...changed.requirements,
        capabilities: ['filesystem.write'],
      };
      expect(workflowIRsAreSemanticallyEqual(changed, minimalIr())).toBe(false);
    });
  });
});

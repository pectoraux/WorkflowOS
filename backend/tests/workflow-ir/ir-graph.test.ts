import { describe, it, expect } from 'vitest';
import { validateWorkflowIR } from '../../src/workflow-ir/index.js';
import type { WorkflowIR } from '../../src/workflow-ir/index.js';
import { minimalIr, realWeeklyReportIr, expectWorkflowIRError } from './fixtures.js';

/**
 * V2-003 — malformed graph discrimination tests.
 *
 * Work Order mapping ("Required regressions" → "invalid graph rejection"):
 * every structurally or semantically invalid control graph fails closed with
 * a distinct frozen error reason — ambiguous or unsupported control semantics
 * are never silently accepted.
 */

/** Mutate a copy of `doc` as a loose record. */
function rawMut(doc: WorkflowIR, edit: (m: Record<string, unknown>) => void): unknown {
  const clone: Record<string, unknown> = structuredClone(doc) as unknown as Record<
    string,
    unknown
  >;
  edit(clone);
  return clone;
}

type LooseNode = Record<string, unknown>;
type LooseEdge = Record<string, unknown>;

function nodesOf(m: Record<string, unknown>): LooseNode[] {
  return m.nodes as LooseNode[];
}

function edgesOf(m: Record<string, unknown>): LooseEdge[] {
  return m.edges as LooseEdge[];
}

function findNode(m: Record<string, unknown>, id: string): LooseNode {
  const node = nodesOf(m).find((n) => n.id === id);
  expect(node, `fixture node ${id} must exist`).toBeDefined();
  return node!;
}

describe('WorkflowIR malformed graph discrimination', () => {
  describe('edge endpoint integrity', () => {
    it('rejects an edge to an unknown node', () => {
      const doc = rawMut(minimalIr(), (m) => {
        edgesOf(m)[1]!.to = 'ghost_node';
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_NODE');
    });

    it('rejects an edge from an unknown node', () => {
      const doc = rawMut(minimalIr(), (m) => {
        edgesOf(m)[1]!.from = 'ghost_node';
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_NODE');
    });

    it('rejects a self edge', () => {
      const doc = rawMut(minimalIr(), (m) => {
        edgesOf(m)[1] = { from: 'do_work', to: 'do_work', kind: 'on_success' };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_EDGE');
    });

    it('rejects a duplicate edge (same from/kind/case/to)', () => {
      const doc = rawMut(minimalIr(), (m) => {
        edgesOf(m).push({ from: 'do_work', to: 'done', kind: 'on_success' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'DUPLICATE_EDGE');
    });

    it('rejects an unknown edge kind', () => {
      const doc = rawMut(minimalIr(), (m) => {
        edgesOf(m)[1]!.kind = 'on_pause';
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_FIELD');
    });

    it('rejects a case reference on a non-on_case edge', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'start', to: 'done', kind: 'on_success', case: 'urgent' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONTROL_EDGE');
    });
  });

  describe('start node semantics', () => {
    it('rejects a graph without a start node', () => {
      const doc = rawMut(minimalIr(), (m) => {
        m.nodes = nodesOf(m).filter((n) => n.kind !== 'start');
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'START_NODE_INVALID');
    });

    it('rejects a graph with two start nodes', () => {
      const doc = rawMut(minimalIr(), (m) => {
        nodesOf(m).push({ kind: 'start', id: 'start_two' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'START_NODE_INVALID');
    });

    it('rejects a start node with an incoming edge', () => {
      const doc = rawMut(minimalIr(), (m) => {
        edgesOf(m).push({ from: 'do_work', to: 'start', kind: 'on_failure' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'START_NODE_INVALID');
    });

    it('rejects a start node without its single on_success edge', () => {
      const doc = rawMut(minimalIr(), (m) => {
        m.edges = edgesOf(m).filter((e) => e.from !== 'start');
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'AMBIGUOUS_CONTROL');
    });

    it('rejects a start node with an on_failure edge', () => {
      const doc = rawMut(minimalIr(), (m) => {
        edgesOf(m).push({ from: 'start', to: 'done', kind: 'on_failure' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONTROL_EDGE');
    });
  });

  describe('end node semantics', () => {
    it('rejects a graph without an end node', () => {
      const doc = rawMut(minimalIr(), (m) => {
        m.nodes = nodesOf(m).filter((n) => n.kind !== 'end');
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'END_NODE_INVALID');
    });

    it('rejects an end node with an outgoing edge', () => {
      const doc = rawMut(minimalIr(), (m) => {
        edgesOf(m).push({ from: 'done', to: 'do_work', kind: 'on_success' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'END_NODE_INVALID');
    });

    it('accepts a failure-outcome end node wired from on_failure (error handling)', () => {
      // realWeeklyReportIr already has draft_summary → failed (on_failure);
      // validating the fixture is the positive control.
      const ir = validateWorkflowIR(realWeeklyReportIr());
      expect(ir.nodes.some((n) => n.kind === 'end' && n.outcome === 'failure')).toBe(true);
      expect(
        ir.edges.some((e) => e.kind === 'on_failure' && e.to === 'failed'),
      ).toBe(true);
    });
  });

  describe('step control semantics', () => {
    it('rejects a step without an on_success edge', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        m.edges = edgesOf(m).filter((e) => !(e.from === 'upload_report' && e.kind === 'on_success'));
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'AMBIGUOUS_CONTROL');
    });

    it('rejects a step with two on_success edges (non-deterministic flow)', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'upload_report', to: 'done', kind: 'on_success' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'AMBIGUOUS_CONTROL');
    });

    it('rejects a step with two on_failure edges', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'draft_summary', to: 'done', kind: 'on_failure' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'AMBIGUOUS_CONTROL');
    });

    it('rejects an on_failure edge from an end node', () => {
      const doc = rawMut(minimalIr(), (m) => {
        edgesOf(m).push({ from: 'done', to: 'do_work', kind: 'on_failure' });
      });
      // END_NODE_INVALID fires first (end nodes may not have outgoing edges).
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'END_NODE_INVALID');
    });

    it('rejects an on_failure edge from a decision node', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'recipient_check', to: 'failed', kind: 'on_failure' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONTROL_EDGE');
    });
  });

  describe('approval (human) control semantics', () => {
    it('rejects an approval step missing its on_rejection edge', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        m.edges = edgesOf(m).filter((e) => e.kind !== 'on_rejection');
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'AMBIGUOUS_CONTROL');
    });

    it('rejects an approval step missing its on_approval edge', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        m.edges = edgesOf(m).filter((e) => e.kind !== 'on_approval');
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'AMBIGUOUS_CONTROL');
    });

    it('rejects an on_approval edge from a non-approval step', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'upload_report', to: 'done', kind: 'on_approval' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONTROL_EDGE');
    });

    it('rejects an on_success edge from an approval step', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'approve_release', to: 'done', kind: 'on_success' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONTROL_EDGE');
    });

    it('rejects an on_failure edge from an approval step', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'approve_release', to: 'failed', kind: 'on_failure' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONTROL_EDGE');
    });

    it('rejects an approval step with two on_approval edges', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'approve_release', to: 'done', kind: 'on_approval' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'AMBIGUOUS_CONTROL');
    });
  });

  describe('decision control semantics', () => {
    it('rejects a decision without its on_default edge', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        m.edges = edgesOf(m).filter((e) => e.kind !== 'on_default');
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'AMBIGUOUS_CONTROL');
    });

    it('rejects a decision with two on_default edges', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'recipient_check', to: 'done', kind: 'on_default' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'AMBIGUOUS_CONTROL');
    });

    it('rejects a declared case without its on_case edge (uncovered case)', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        m.edges = edgesOf(m).filter((e) => e.kind !== 'on_case');
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'AMBIGUOUS_CONTROL');
    });

    it('rejects an on_case edge referencing an undeclared case', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m)[6] = { from: 'recipient_check', to: 'notify_team', kind: 'on_case', case: 'critical' };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONTROL_EDGE');
    });

    it('rejects an on_case edge without a case reference', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m)[6] = { from: 'recipient_check', to: 'notify_team', kind: 'on_case' };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONTROL_EDGE');
    });

    it('rejects an on_case edge from a non-decision node', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'upload_report', to: 'done', kind: 'on_case', case: 'urgent' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONTROL_EDGE');
    });

    it('rejects an on_success edge from a decision node', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'recipient_check', to: 'done', kind: 'on_success' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONTROL_EDGE');
    });

    it('rejects an on_default edge from a non-decision node', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        edgesOf(m).push({ from: 'upload_report', to: 'failed', kind: 'on_default' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONTROL_EDGE');
    });

    it('rejects a decision with an empty case list (no branch semantics)', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        findNode(m, 'recipient_check').cases = [];
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_DECISION');
    });

    it('rejects a decision with a duplicate case id', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        findNode(m, 'recipient_check').cases = [
          { id: 'urgent', condition: { kind: 'equals', value: 'urgent' } },
          { id: 'urgent', condition: { kind: 'exists' } },
        ];
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_DECISION');
    });

    it('rejects a malformed decision condition', () => {
      for (const bad of [{ kind: 'matches' }, { kind: 'equals' }, { kind: 'exists', value: 1 }]) {
        const doc = rawMut(realWeeklyReportIr(), (m) => {
          findNode(m, 'recipient_check').cases = [{ id: 'urgent', condition: bad }];
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONDITION');
      }
    });
  });

  describe('graph topology', () => {
    it('rejects an unreachable node (disconnected subgraph)', () => {
      const doc = rawMut(minimalIr(), (m) => {
        nodesOf(m).push({
          kind: 'step',
          id: 'orphan_step',
          instruction: 'Nobody reaches this step.',
          executionClass: 'human',
          inputs: [],
          outputs: [],
        });
        // the orphan has its required on_success edge, but nothing reaches it
        edgesOf(m).push({ from: 'orphan_step', to: 'done', kind: 'on_success' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNREACHABLE_NODE');
    });

    it('rejects a control cycle that does not touch the start node', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        // upload_report --on_success--> draft_summary creates
        // draft → approve → recipient_check --on_default--> upload → draft
        // while every node stays reachable from start (notify_team via the
        // urgent case, archive_run and done via notify_team).
        for (const edge of edgesOf(m)) {
          if (edge.from === 'upload_report' && edge.kind === 'on_success') edge.to = 'draft_summary';
        }
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'CONTROL_CYCLE');
    });

    it('rejects a control cycle routed through a decision', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        // route the urgent case back into draft_summary:
        // draft → approve --on_approval--> recipient_check --on_case urgent-->
        // draft_summary (cycle); every node remains reachable.
        for (const edge of edgesOf(m)) {
          if (edge.kind === 'on_case' && edge.case === 'urgent') edge.to = 'draft_summary';
        }
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'CONTROL_CYCLE');
    });
  });

  it('positive control: the real workflow graph is accepted', () => {
    expect(() => validateWorkflowIR(realWeeklyReportIr())).not.toThrow();
  });
});

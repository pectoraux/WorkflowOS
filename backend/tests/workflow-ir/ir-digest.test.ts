import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  serializeWorkflowIR,
  deserializeWorkflowIR,
  computeWorkflowIRDigest,
  workflowIRsAreSemanticallyEqual,
  WORKFLOW_IR_DIGEST_ALGORITHM,
} from '../../src/workflow-ir/index.js';
import type { DeepMutableWorkflowIR } from '../../src/workflow-ir/index.js';
import {
  minimalIr,
  realWeeklyReportIr,
  MINIMAL_IR_CANONICAL_TEXT,
} from './fixtures.js';

/**
 * V2-003 — semantic digest tests.
 *
 * Work Order mapping ("Required regressions" → "deterministic digest"; work
 * order invariants → "Semantically equivalent representations must have the
 * expected canonical identity" and "Semantically different workflows must
 * not collapse to the same semantic digest").
 *
 * Registry rule (V2-CTRL-003): the digest value is
 *   SHA-256(canonical-json(semantic-object))
 * — presentation formatting, transport envelopes and repository/marketplace
 * metadata are excluded.
 */
describe('WorkflowIR semantic digest', () => {
  it('produces a 64-character lowercase hex SHA-256 value', () => {
    const digest = computeWorkflowIRDigest(minimalIr());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(WORKFLOW_IR_DIGEST_ALGORITHM).toBe('SHA-256');
  });

  it('is deterministic across repeated computation', () => {
    const a = computeWorkflowIRDigest(realWeeklyReportIr());
    const b = computeWorkflowIRDigest(realWeeklyReportIr());
    const c = computeWorkflowIRDigest(
      deserializeWorkflowIR(serializeWorkflowIR(realWeeklyReportIr())),
    );
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('is the SHA-256 of the canonical serialization (registry rule)', () => {
    // cross-checked against node:crypto directly
    const text = serializeWorkflowIR(minimalIr());
    expect(computeWorkflowIRDigest(minimalIr())).toBe(sha256Hex(text));
    expect(text).toBe(MINIMAL_IR_CANONICAL_TEXT);
  });

  describe('presentation changes do NOT change the digest', () => {
    it('pretty-printing, key order and array order are excluded', () => {
      const shuffled = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
      shuffled.nodes = [...shuffled.nodes].reverse();
      shuffled.edges = [...shuffled.edges].reverse();
      shuffled.dataBindings = [...shuffled.dataBindings].reverse();
      shuffled.inputs = [...shuffled.inputs].reverse();
      shuffled.dependencies = [...shuffled.dependencies].reverse();
      const pretty = JSON.stringify(realWeeklyReportIr(), null, 2);
      expect(computeWorkflowIRDigest(shuffled)).toBe(
        computeWorkflowIRDigest(realWeeklyReportIr()),
      );
      expect(computeWorkflowIRDigest(JSON.parse(pretty) as unknown)).toBe(
        computeWorkflowIRDigest(realWeeklyReportIr()),
      );
    });

    it('explicit schema defaults are excluded', () => {
      const explicit = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
      explicit.nodes = explicit.nodes.map((n) => {
        if (n.kind !== 'step') return n;
        return {
          ...n,
          pauseSafe: n.pauseSafe ?? false,
          requestApproval: n.requestApproval ?? false,
          failure: n.failure ?? { retry: 0 },
        };
      });
      expect(computeWorkflowIRDigest(explicit)).toBe(
        computeWorkflowIRDigest(realWeeklyReportIr()),
      );
    });

    it('an authored capabilities set in different order is the same set', () => {
      const reordered = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
      reordered.requirements = {
        ...reordered.requirements,
        capabilities: [...reordered.requirements.capabilities].reverse(),
      };
      expect(computeWorkflowIRDigest(reordered)).toBe(
        computeWorkflowIRDigest(realWeeklyReportIr()),
      );
    });

    it('duplicate entries in set-valued collections collapse', () => {
      const duplicated = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
      duplicated.provenance = {
        ...duplicated.provenance,
        sourceReferences: [...(duplicated.provenance.sourceReferences ?? []), 'brief-w34'],
      };
      // 'brief-w34' is already present → the set collapses → same semantics.
      expect(computeWorkflowIRDigest(duplicated)).toBe(
        computeWorkflowIRDigest(realWeeklyReportIr()),
      );
    });
  });

  describe('semantic mutations DO change the digest (no collapse)', () => {
    const mutations: Array<[string, (doc: DeepMutableWorkflowIR) => void]> = [
      [
        'add an extra step',
        (doc) => {
          doc.nodes.push({
            kind: 'step',
            id: 'extra_step',
            instruction: 'An additional step.',
            executionClass: 'human',
            inputs: [],
            outputs: [],
          });
          doc.edges = doc.edges.filter((e) => !(e.from === 'archive_run' && e.to === 'done'));
          doc.edges.push({ from: 'archive_run', to: 'extra_step', kind: 'on_success' });
          doc.edges.push({ from: 'extra_step', to: 'done', kind: 'on_success' });
        },
      ],
      [
        'change one instruction',
        (doc) => {
          const node = doc.nodes.find((n) => n.id === 'notify_team');
          if (node && node.kind === 'step') node.instruction = 'Send the summary message to the recipients.';
        },
      ],
      [
        'change one capability',
        (doc) => {
          const node = doc.nodes.find((n) => n.id === 'upload_report');
          if (node && node.kind === 'step' && 'capability' in node)
            node.capability = 'filesystem.write';
        },
      ],
      [
        'change one execution class',
        (doc) => {
          const node = doc.nodes.find((n) => n.id === 'draft_summary');
          if (node && node.kind === 'step') node.executionClass = 'deterministic_api';
        },
      ],
      [
        'change placement locality',
        (doc) => {
          doc.requirements.placement.locality = 'cloud_allowed';
        },
      ],
      [
        'add a disallowed placement',
        (doc) => {
          doc.requirements.placement.disallowed = ['cloud_preferred'];
        },
      ],
      [
        'change a failure retry count',
        (doc) => {
          const node = doc.nodes.find((n) => n.id === 'draft_summary');
          if (node && node.kind === 'step') node.failure = { retry: 2 };
        },
      ],
      [
        'add a second decision case',
        (doc) => {
          const node = doc.nodes.find((n) => n.id === 'recipient_check');
          if (node && node.kind === 'decision') {
            node.cases = [
              { id: 'urgent', condition: { kind: 'equals', value: 'urgent' } },
              { id: 'high', condition: { kind: 'exists' } },
            ];
          }
          doc.edges = [
            ...doc.edges.filter((e) => e.kind !== 'on_case' && e.kind !== 'on_default'),
            { from: 'recipient_check', to: 'notify_team', kind: 'on_case', case: 'urgent' },
            { from: 'recipient_check', to: 'upload_report', kind: 'on_case', case: 'high' },
            { from: 'recipient_check', to: 'archive_run', kind: 'on_default' },
          ];
        },
      ],
      [
        'reorder decision cases (evaluation order is semantic)',
        (doc) => {
          const node = doc.nodes.find((n) => n.id === 'recipient_check');
          if (node && node.kind === 'decision') {
            node.cases = [
              { id: 'high', condition: { kind: 'exists' } },
              { id: 'urgent', condition: { kind: 'equals', value: 'urgent' } },
            ];
          }
          doc.edges = [
            ...doc.edges.filter((e) => e.kind !== 'on_case' && e.kind !== 'on_default'),
            { from: 'recipient_check', to: 'upload_report', kind: 'on_case', case: 'high' },
            { from: 'recipient_check', to: 'notify_team', kind: 'on_case', case: 'urgent' },
            { from: 'recipient_check', to: 'archive_run', kind: 'on_default' },
          ];
        },
      ],
      [
        'change a case condition value',
        (doc) => {
          const node = doc.nodes.find((n) => n.id === 'recipient_check');
          if (node && node.kind === 'decision') {
            node.cases = [{ id: 'urgent', condition: { kind: 'equals', value: 'asap' } }];
          }
        },
      ],
      [
        'change a case condition kind',
        (doc) => {
          const node = doc.nodes.find((n) => n.id === 'recipient_check');
          if (node && node.kind === 'decision') {
            node.cases = [{ id: 'urgent', condition: { kind: 'exists' } }];
          }
        },
      ],
      [
        'rename a node id (graph anchors are part of canonical identity)',
        (doc) => {
          doc.nodes = doc.nodes.map((n) =>
            n.id === 'notify_team' ? { ...n, id: 'notify_the_team' } : n,
          );
          doc.edges = doc.edges.map((e) => ({
            ...e,
            from: e.from === 'notify_team' ? 'notify_the_team' : e.from,
            to: e.to === 'notify_team' ? 'notify_the_team' : e.to,
          }));
          doc.dataBindings = doc.dataBindings.map((b) => {
            if (b.target.kind === 'node_input' && b.target.node === 'notify_team') {
              return { ...b, target: { ...b.target, node: 'notify_the_team' } };
            }
            return b;
          });
        },
      ],
      [
        'rewire one control edge',
        (doc) => {
          const edge = doc.edges.find((e) => e.from === 'upload_report' && e.kind === 'on_success');
          if (edge) edge.to = 'archive_run';
        },
      ],
      [
        'change a data binding source',
        (doc) => {
          const binding = doc.dataBindings.find(
            (b) => b.source.kind === 'node_output' && b.source.node === 'read_crm_export',
          );
          if (binding && binding.source.kind === 'node_output') {
            binding.source = { kind: 'literal', literal: { type: 'json', value: [] } };
          }
        },
      ],
      [
        'change a second capability (browser.upload → browser.download)',
        (doc) => {
          const node = doc.nodes.find((n) => n.id === 'upload_report');
          if (node && node.kind === 'step' && 'capability' in node)
            node.capability = 'browser.download';
        },
      ],
      [
        'change provenance origin',
        (doc) => {
          doc.provenance.origin = 'compiled';
        },
      ],
      [
        'change provenance generator',
        (doc) => {
          doc.provenance.generator = 'workflowos-authoring-fixture/2';
        },
      ],
      [
        'change provenance source references',
        (doc) => {
          doc.provenance.sourceReferences = ['brief-w36'];
        },
      ],
      [
        'change the subworkflow dependency target',
        (doc) => {
          const dep = doc.dependencies[0];
          if (dep) dep.workflowVersionId = 'wf-archival@v4';
        },
      ],
      [
        'change an end outcome',
        (doc) => {
          const node = doc.nodes.find((n) => n.id === 'failed');
          if (node && node.kind === 'end') node.outcome = undefined;
        },
      ],
      [
        'change a port type',
        (doc) => {
          const node = doc.nodes.find((n) => n.id === 'notify_team');
          if (node && node.kind === 'step') {
            const input = node.inputs.find((p) => p.id === 'message');
            if (input) input.type = 'json';
          }
          const binding = doc.dataBindings.find(
            (b) =>
              b.target.kind === 'node_input' &&
              b.target.node === 'notify_team' &&
              b.target.port === 'message',
          );
          if (binding && binding.source.kind === 'node_output') {
            binding.source = {
              kind: 'node_output',
              node: 'read_crm_export',
              port: 'engagements',
            };
          }
        },
      ],
      [
        'change a workflow output type',
        (doc) => {
          const output = doc.outputs[0];
          if (output) output.type = 'json';
          const binding = doc.dataBindings.find((b) => b.target.kind === 'workflow_output');
          if (binding && binding.source.kind === 'node_output') {
            binding.source = {
              kind: 'node_output',
              node: 'read_crm_export',
              port: 'engagements',
            };
          }
        },
      ],
    ];

    const baseDigest = computeWorkflowIRDigest(realWeeklyReportIr());
    const digests = new Set<string>([baseDigest]);

    for (const [label, mutate] of mutations) {
      it(`mutation "${label}" produces a different digest`, () => {
        const doc = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
        mutate(doc);
        const mutatedDigest = computeWorkflowIRDigest(doc);
        expect(mutatedDigest, `mutation "${label}" collapsed to the base digest`).not.toBe(
          baseDigest,
        );
        digests.add(mutatedDigest);
      });
    }

    it('all mutated workflows have pairwise-distinct digests', () => {
      // no two semantically different documents share a digest
      expect(digests.size).toBe(mutations.length + 1);
    });
  });

  it('the minimal IR and the real workflow never share a digest', () => {
    expect(computeWorkflowIRDigest(minimalIr())).not.toBe(
      computeWorkflowIRDigest(realWeeklyReportIr()),
    );
  });

  it('workflowIRsAreSemanticallyEqual mirrors digest equality and fails closed', () => {
    expect(
      workflowIRsAreSemanticallyEqual(minimalIr(), minimalIr()),
    ).toBe(true);
    expect(
      workflowIRsAreSemanticallyEqual(minimalIr(), realWeeklyReportIr()),
    ).toBe(false);
  });
});

/** Independent SHA-256 computation path (node:crypto) for cross-checking. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

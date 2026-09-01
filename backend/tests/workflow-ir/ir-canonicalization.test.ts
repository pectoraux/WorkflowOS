import { describe, it, expect } from 'vitest';
import {
  validateWorkflowIR,
  serializeWorkflowIR,
  canonicalJsonString,
  computeWorkflowIRDigest,
} from '../../src/workflow-ir/index.js';
import type { DeepMutableWorkflowIR, WorkflowIR } from '../../src/workflow-ir/index.js';
import {
  minimalIr,
  minimalIrNonCanonicalText,
  realWeeklyReportIr,
  MINIMAL_IR_CANONICAL_TEXT,
} from './fixtures.js';

/**
 * V2-003 — canonicalization tests.
 *
 * Work Order mapping ("Must deliver" → "deterministic serialization"):
 * the canonical serialization is the deterministic presentation of the
 * semantic object (registry "Canonical identity and digest rules"):
 * - UTF-8 JSON, no insignificant whitespace;
 * - deterministic object-key ordering (lexicographic by code unit);
 * - deterministic array ordering for schema-declared sets (nodes, edges,
 *   data bindings, workflow inputs/outputs, capabilities, disallowed
 *   placements, provenance source references);
 * - authored order preserved exactly where the schema declares order
 *   (decision case evaluation order);
 * - normalized representation: optional fields equal to their schema default
 *   are omitted; the capability requirement set is derived from steps.
 *
 * Determinism: repeated runs are byte-identical; no clock, no randomness.
 */

describe('WorkflowIR canonicalization', () => {
  it('produces the exact golden canonical serialization of the minimal IR', () => {
    expect(serializeWorkflowIR(minimalIr())).toBe(MINIMAL_IR_CANONICAL_TEXT);
  });

  it('canonicalizes a non-canonical presentation of the same semantics to identical bytes', () => {
    // pretty-printed, key order shuffled, arrays reversed, empty disallowed present
    const deserialized = validateWorkflowIR(
      JSON.parse(minimalIrNonCanonicalText()) as unknown,
    );
    expect(serializeWorkflowIR(deserialized)).toBe(MINIMAL_IR_CANONICAL_TEXT);
  });

  it('contains no insignificant whitespace', () => {
    const text = serializeWorkflowIR(realWeeklyReportIr());
    expect(text).not.toMatch(/\s/);
  });

  it('sorts object keys lexicographically at every level', () => {
    const text = serializeWorkflowIR(realWeeklyReportIr());
    // spot-check key ordering in the top-level object and inside nodes
    const doc = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual([
      'dataBindings',
      'dependencies',
      'edges',
      'inputs',
      'nodes',
      'outputs',
      'provenance',
      'requirements',
      'schemaVersion',
    ]);
    const nodes = doc.nodes as Record<string, unknown>[];
    const step = nodes.find((n) => n.kind === 'step' && n.capability === 'browser.upload');
    expect(Object.keys(step!)).toEqual([
      'capability',
      'executionClass',
      'id',
      'inputs',
      'instruction',
      'kind',
      'outputs',
    ]);
  });

  it('sorts nodes by id', () => {
    const ir = validateWorkflowIR(realWeeklyReportIr());
    expect(ir.nodes.map((n) => n.id)).toEqual([...ir.nodes.map((n) => n.id)].sort());
  });

  it('sorts edges by (from, kind, case, to)', () => {
    const ir = validateWorkflowIR(realWeeklyReportIr());
    const keys = ir.edges.map((e) => [e.from, e.kind, e.case ?? '', e.to].join('\u0000'));
    expect(keys).toEqual([...keys].sort());
  });

  it('sorts data bindings by target then source tuple', () => {
    const ir = validateWorkflowIR(realWeeklyReportIr());
    const keys = ir.dataBindings.map((b) =>
      [
        b.target.kind,
        b.target.kind === 'node_input' ? b.target.node : b.target.output,
        b.target.kind === 'node_input' ? b.target.port : '',
        JSON.stringify(b.source),
      ].join('\u0000'),
    );
    expect(keys).toEqual([...keys].sort());
  });

  it('sorts workflow inputs and outputs by id', () => {
    const ir = validateWorkflowIR(realWeeklyReportIr());
    expect(ir.inputs.map((i) => i.id)).toEqual([...ir.inputs.map((i) => i.id)].sort());
    expect(ir.outputs.map((o) => o.id)).toEqual([...ir.outputs.map((o) => o.id)].sort());
  });

  it('derives and sorts the capability requirement set from steps', () => {
    const ir = validateWorkflowIR(realWeeklyReportIr());
    expect(ir.requirements.capabilities).toEqual([
      'browser.upload',
      'filesystem.write',
      'messaging.send',
      'spreadsheet.read',
    ]);
  });

  it('sorts and de-duplicates disallowed placements and source references', () => {
    const shuffled = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
    shuffled.requirements = {
      capabilities: shuffled.requirements.capabilities,
      placement: {
        locality: 'device_preferred',
        disallowed: ['cloud_required', 'device_local'],
      },
    };
    shuffled.provenance = {
      origin: 'authored',
      generator: 'workflowos-authoring-fixture/1',
      sourceReferences: ['brief-z', 'brief-a', 'brief-m'],
    };
    const ir = validateWorkflowIR(shuffled);
    expect(ir.requirements.placement.disallowed).toEqual(['cloud_required', 'device_local']);
    expect(ir.provenance.sourceReferences).toEqual(['brief-a', 'brief-m', 'brief-z']);
  });

  it('omits optional fields equal to their schema default', () => {
    const explicit = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
    // state every default explicitly…
    explicit.nodes = explicit.nodes.map((n) => {
      if (n.kind === 'step') {
        return {
          ...n,
          pauseSafe: n.pauseSafe ?? false,
          requestApproval: n.requestApproval ?? false,
          failure: n.failure ?? { retry: 0 },
        };
      }
      return n;
    });
    // …and the serialization must equal the authored (default-omitted) form
    expect(serializeWorkflowIR(explicit)).toBe(serializeWorkflowIR(realWeeklyReportIr()));
    const ir = validateWorkflowIR(realWeeklyReportIr());
    expect(ir.nodes.some((n) => n.kind === 'step' && 'requestApproval' in n && n.requestApproval === false)).toBe(false);
    expect(ir.nodes.some((n) => n.kind === 'end' && 'outcome' in n && n.outcome === 'success')).toBe(false);
  });

  it('omits empty optional collections', () => {
    const text = serializeWorkflowIR(minimalIr());
    expect(text).not.toContain('"disallowed"');
    expect(text).not.toContain('"sourceReferences"');
    expect(text).not.toContain('"generator"');
  });

  it('preserves authored decision case order (order is semantic)', () => {
    const twoCases = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
    twoCases.nodes = twoCases.nodes.map((n) => {
      if (n.kind !== 'decision') return n;
      return {
        ...n,
        cases: [
          { id: 'urgent', condition: { kind: 'equals', value: 'urgent' } },
          { id: 'high', condition: { kind: 'exists' } },
        ],
      };
    });
    twoCases.edges = [
      ...twoCases.edges.filter((e) => e.kind !== 'on_case' && e.kind !== 'on_default'),
      { from: 'recipient_check', to: 'notify_team', kind: 'on_case', case: 'urgent' },
      { from: 'recipient_check', to: 'upload_report', kind: 'on_case', case: 'high' },
      { from: 'recipient_check', to: 'archive_run', kind: 'on_default' },
    ];
    const ir = validateWorkflowIR(twoCases);
    const decision = ir.nodes.find((n) => n.id === 'recipient_check');
    expect(decision && decision.kind === 'decision' ? decision.cases.map((c) => c.id) : []).toEqual([
      'urgent',
      'high',
    ]);
    const reordered = structuredClone(twoCases) as DeepMutableWorkflowIR;
    reordered.nodes = reordered.nodes.map((n) => {
      if (n.kind !== 'decision') return n;
      return {
        ...n,
        cases: [
          { id: 'high', condition: { kind: 'exists' } },
          { id: 'urgent', condition: { kind: 'equals', value: 'urgent' } },
        ],
      };
    });
    // reordering cases is a SEMANTIC change (evaluation order) — different bytes
    expect(serializeWorkflowIR(reordered)).not.toBe(serializeWorkflowIR(twoCases));
  });

  it('repeated serialization runs are byte-identical (determinism, no clock/randomness)', () => {
    const first = serializeWorkflowIR(realWeeklyReportIr());
    const second = serializeWorkflowIR(realWeeklyReportIr());
    const third = serializeWorkflowIR(
      validateWorkflowIR(JSON.parse(first) as unknown),
    );
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(computeWorkflowIRDigest(realWeeklyReportIr())).toBe(
      computeWorkflowIRDigest(realWeeklyReportIr()),
    );
  });

  it('is insensitive to authored array insertion order', () => {
    const shuffled = structuredClone(realWeeklyReportIr()) as DeepMutableWorkflowIR;
    shuffled.nodes = [...shuffled.nodes].reverse();
    shuffled.edges = [...shuffled.edges].reverse();
    shuffled.dataBindings = [...shuffled.dataBindings].reverse();
    shuffled.inputs = [...shuffled.inputs].reverse();
    shuffled.dependencies = [...shuffled.dependencies].reverse();
    expect(serializeWorkflowIR(shuffled)).toBe(serializeWorkflowIR(realWeeklyReportIr()));
  });

  it('canonicalJsonString sorts keys recursively and rejects non-JSON values', () => {
    expect(canonicalJsonString({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJsonString([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJsonString('é')).toBe('"é"');
    expect(canonicalJsonString(null)).toBe('null');
    expect(() => canonicalJsonString(undefined)).toThrow();
    expect(() => canonicalJsonString({ bad: Number.NaN })).toThrow();
    expect(() => canonicalJsonString({ bad: -0 })).toThrow();
    expect(() => canonicalJsonString(new Date(0))).toThrow();
  });

  it('canonical form is independent of object key insertion order', () => {
    const a = { x: 1, y: { b: 'two', a: 'one' } };
    const b = { y: { a: 'one', b: 'two' }, x: 1 };
    expect(canonicalJsonString(a)).toBe(canonicalJsonString(b));
  });

  it('unicode escapes normalize to the same canonical bytes', () => {
    const doc = structuredClone(realWeeklyReportIr()) as WorkflowIR;
    const unicodeText = JSON.stringify(doc).replace(
      'Draft the weekly summary',
      'Draft the \\u00e9\\u00e9 summary',
    );
    const directText = JSON.stringify(doc).replace(
      'Draft the weekly summary',
      'Draft the éé summary',
    );
    expect(serializeWorkflowIR(JSON.parse(unicodeText) as unknown)).toBe(
      serializeWorkflowIR(JSON.parse(directText) as unknown),
    );
  });
});

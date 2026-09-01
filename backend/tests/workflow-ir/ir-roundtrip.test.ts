import { describe, it, expect } from 'vitest';
import {
  serializeWorkflowIR,
  deserializeWorkflowIR,
  validateWorkflowIR,
  computeWorkflowIRDigest,
  workflowIRsAreSemanticallyEqual,
} from '../../src/workflow-ir/index.js';
import {
  minimalIr,
  minimalIrNonCanonicalText,
  realWeeklyReportIr,
  MINIMAL_IR_CANONICAL_TEXT,
  expectWorkflowIRError,
} from './fixtures.js';

/**
 * V2-003 — semantic round-trip tests.
 *
 * Work Order mapping ("Required regressions" → "round-trip identity" and
 * "Must deliver" → "lossless semantic round-trip"):
 * serialize → deserialize → serialize is byte-stable and the deserialized
 * IR is semantically identical to the validated original; presentation
 * (whitespace, key order, unicode escapes, array order) is excluded from
 * meaning; every semantic element survives the round trip.
 */
describe('WorkflowIR round-trip', () => {
  it('serialize → deserialize → serialize is byte-identical (minimal IR)', () => {
    const text1 = serializeWorkflowIR(minimalIr());
    const roundTripped = deserializeWorkflowIR(text1);
    const text2 = serializeWorkflowIR(roundTripped);
    expect(text2).toBe(text1);
    expect(text1).toBe(MINIMAL_IR_CANONICAL_TEXT);
  });

  it('serialize → deserialize → serialize is byte-identical (real workflow)', () => {
    const text1 = serializeWorkflowIR(realWeeklyReportIr());
    const roundTripped = deserializeWorkflowIR(text1);
    expect(serializeWorkflowIR(roundTripped)).toBe(text1);
  });

  it('deserialize(serialize(ir)) equals canonicalize(ir) (deep semantic equality)', () => {
    const canonical = validateWorkflowIR(realWeeklyReportIr());
    const roundTripped = deserializeWorkflowIR(serializeWorkflowIR(realWeeklyReportIr()));
    expect(workflowIRsAreSemanticallyEqual(roundTripped, canonical)).toBe(true);
    // and structurally:
    expect(roundTripped).toEqual(canonical);
  });

  it('presentation is excluded from meaning: pretty-print and key shuffle converge', () => {
    const canonicalText = serializeWorkflowIR(minimalIr());
    const fromPretty = serializeWorkflowIR(
      deserializeWorkflowIR(minimalIrNonCanonicalText()),
    );
    expect(fromPretty).toBe(canonicalText);
  });

  it('digest is invariant across the round trip', () => {
    const ir = realWeeklyReportIr();
    const before = computeWorkflowIRDigest(ir);
    const after = computeWorkflowIRDigest(deserializeWorkflowIR(serializeWorkflowIR(ir)));
    expect(after).toBe(before);
  });

  it('every semantic element survives the round trip (real workflow)', () => {
    const original = validateWorkflowIR(realWeeklyReportIr());
    const roundTripped = deserializeWorkflowIR(serializeWorkflowIR(original));

    // nodes: kind, id, instruction, class, capability/dependency, ports, flags
    expect(roundTripped.nodes).toHaveLength(original.nodes.length);
    for (const node of original.nodes) {
      const other = roundTripped.nodes.find((n) => n.id === node.id);
      expect(other, `node ${node.id} must survive the round trip`).toBeDefined();
      expect(other).toEqual(node);
    }

    // control edges as an ordered set
    expect(roundTripped.edges).toEqual(original.edges);

    // data bindings as a set
    expect(roundTripped.dataBindings).toEqual(original.dataBindings);

    // workflow interface, dependencies, requirements, provenance
    expect(roundTripped.inputs).toEqual(original.inputs);
    expect(roundTripped.outputs).toEqual(original.outputs);
    expect(roundTripped.dependencies).toEqual(original.dependencies);
    expect(roundTripped.requirements).toEqual(original.requirements);
    expect(roundTripped.provenance).toEqual(original.provenance);
    expect(roundTripped.schemaVersion).toBe(original.schemaVersion);
  });

  it('instruction text (user-visible meaning) survives byte-identically', () => {
    const original = validateWorkflowIR(realWeeklyReportIr());
    const roundTripped = deserializeWorkflowIR(serializeWorkflowIR(original));
    const instructions = (ir: typeof original) =>
      ir.nodes
        .filter((n) => n.kind === 'step')
        .map((n) => (n.kind === 'step' ? n.instruction : ''))
        .sort();
    expect(instructions(roundTripped)).toEqual(instructions(original));
    for (const node of original.nodes) {
      if (node.kind === 'step') {
        const other = roundTripped.nodes.find(
          (n) => n.id === node.id && n.kind === 'step',
        );
        expect(other && other.kind === 'step' ? other.instruction : '').toBe(node.instruction);
      }
    }
  });

  it('a non-canonical authored document canonicalizes on deserialize', () => {
    const doc = JSON.parse(minimalIrNonCanonicalText()) as unknown;
    const ir = deserializeWorkflowIR(JSON.stringify(doc));
    expect(serializeWorkflowIR(ir)).toBe(MINIMAL_IR_CANONICAL_TEXT);
  });

  it('round-trips repeated N times converge to the same fixed point', () => {
    let text = serializeWorkflowIR(realWeeklyReportIr());
    for (let i = 0; i < 5; i++) {
      text = serializeWorkflowIR(deserializeWorkflowIR(text));
    }
    expect(text).toBe(serializeWorkflowIR(realWeeklyReportIr()));
  });

  describe('strict wire parsing (ambiguous documents fail closed)', () => {
    it('rejects invalid JSON text', () => {
      expectWorkflowIRError(() => deserializeWorkflowIR('{not json'), 'PARSE_ERROR');
      expectWorkflowIRError(() => deserializeWorkflowIR(''), 'PARSE_ERROR');
      expectWorkflowIRError(() => deserializeWorkflowIR('{"schemaVersion":}'), 'PARSE_ERROR');
    });

    it('rejects trailing content after the JSON document', () => {
      expectWorkflowIRError(
        () => deserializeWorkflowIR(`${serializeWorkflowIR(minimalIr())} trailing`),
        'PARSE_ERROR',
      );
    });

    it('rejects duplicate object keys (ambiguous IR)', () => {
      const text = `{"schemaVersion":1,"schemaVersion":2,"nodes":[],"edges":[],"dataBindings":[],"inputs":[],"outputs":[],"dependencies":[],"requirements":{"placement":{"locality":"any_supported_node"}},"provenance":{"origin":"authored"}}`;
      expectWorkflowIRError(() => deserializeWorkflowIR(text), 'PARSE_ERROR');
    });

    it('rejects nested duplicate keys', () => {
      const text = serializeWorkflowIR(minimalIr()).replace(
        '"kind":"end"',
        '"kind":"end","kind":"start"',
      );
      expectWorkflowIRError(() => deserializeWorkflowIR(text), 'PARSE_ERROR');
    });
  });
});

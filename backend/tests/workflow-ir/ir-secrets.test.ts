import { describe, it, expect } from 'vitest';
import {
  validateWorkflowIR,
  serializeWorkflowIR,
  deserializeWorkflowIR,
  computeWorkflowIRDigest,
} from '../../src/workflow-ir/index.js';
import { realWeeklyReportIr, expectWorkflowIRError, FAKE_SECRET_MATERIAL } from './fixtures.js';

/**
 * V2-003 — secret non-leakage tests.
 *
 * Work Order mapping ("Must deliver" → "secret references as opaque values
 * only"; "Required regressions" → "secret non-leakage"; constitution §16 —
 * "Secret material is referenced opaquely and delivered only through
 * authorized runtime paths").
 *
 * The IR schema structurally CANNOT carry secret material: the value type
 * system has no literal form for `secret_ref` — secrets only ever appear as
 * opaque references flowing through secret_ref-typed ports. Serialization
 * therefore never contains secret material.
 */
describe('WorkflowIR secret non-leakage', () => {
  it('the real workflow carries a secret as an opaque typed reference only', () => {
    const ir = validateWorkflowIR(realWeeklyReportIr());
    const tokenInput = ir.inputs.find((i) => i.id === 'api_token');
    expect(tokenInput?.type).toBe('secret_ref');
    const upload = ir.nodes.find((n) => n.id === 'upload_report');
    expect(
      upload && upload.kind === 'step'
        ? upload.inputs.find((p) => p.id === 'token')?.type
        : undefined,
    ).toBe('secret_ref');
    const binding = ir.dataBindings.find(
      (b) =>
        b.source.kind === 'workflow_input' &&
        b.source.input === 'api_token',
    );
    expect(binding?.source).toEqual({ kind: 'workflow_input', input: 'api_token' });
  });

  it('secret_ref values have no literal form — the schema cannot express secret material', () => {
    const doc = structuredClone(realWeeklyReportIr()) as unknown as Record<string, unknown>;
    // try to smuggle secret material as a literal into the secret-typed port
    const bindings = doc.dataBindings as Array<Record<string, unknown>>;
    for (const binding of bindings) {
      const target = binding.target as Record<string, unknown>;
      if (target.kind === 'node_input' && target.port === 'token') {
        binding.source = {
          kind: 'literal',
          literal: { type: 'secret_ref', value: FAKE_SECRET_MATERIAL },
        };
      }
    }
    const err = expectWorkflowIRError(
      () => validateWorkflowIR(doc),
      'SECRET_LITERAL_FORBIDDEN',
    );
    expect(err.message).toContain('opaque');
  });

  it('serialized canonical output contains no secret material', () => {
    const text = serializeWorkflowIR(realWeeklyReportIr());
    expect(text).not.toContain(FAKE_SECRET_MATERIAL);
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('password');
    expect(text).not.toContain('secret_material');
    // the only secret-adjacent token is the opaque type tag
    expect(text).toContain('"secret_ref"');
  });

  it('the round trip never introduces secret material', () => {
    const roundTripped = deserializeWorkflowIR(serializeWorkflowIR(realWeeklyReportIr()));
    const text = serializeWorkflowIR(roundTripped);
    expect(text).not.toContain(FAKE_SECRET_MATERIAL);
    expect(computeWorkflowIRDigest(roundTripped)).toBe(
      computeWorkflowIRDigest(realWeeklyReportIr()),
    );
  });

  it('a secret-typed source cannot be silently bound into a non-secret port', () => {
    const doc = structuredClone(realWeeklyReportIr()) as unknown as Record<string, unknown>;
    const bindings = doc.dataBindings as Array<Record<string, unknown>>;
    for (const binding of bindings) {
      const source = binding.source as Record<string, unknown>;
      if (source.kind === 'workflow_input' && source.input === 'api_token') {
        // retarget the secret into the string-typed 'week' port
        binding.target = { kind: 'node_input', node: 'read_crm_export', port: 'week' };
      }
    }
    // and drop the now-dead 'report_week' input binding
    doc.dataBindings = (doc.dataBindings as Array<Record<string, unknown>>).filter(
      (b) =>
        !(
          (b.source as Record<string, unknown>).kind === 'workflow_input' &&
          (b.source as Record<string, unknown>).input === 'report_week'
        ),
    );
    expectWorkflowIRError(() => validateWorkflowIR(doc), 'TYPE_MISMATCH');
  });

  it('a workflow input named like a credential is still only a typed reference', () => {
    const text = serializeWorkflowIR(realWeeklyReportIr());
    // the workflow declares api_token as an OPAQUE reference — the serialized
    // document contains the input declaration and its type tag, nothing else
    const parsed = JSON.parse(text) as { inputs: Array<{ id: string; type: string }> };
    const token = parsed.inputs.find((i) => i.id === 'api_token');
    expect(token).toEqual({ id: 'api_token', type: 'secret_ref' });
  });

  it('unknown node fields cannot smuggle raw credentials (fail closed)', () => {
    for (const smuggle of [
      { token: FAKE_SECRET_MATERIAL },
      { apiKey: FAKE_SECRET_MATERIAL },
      { password: 'hunter2' },
      { credentials: { username: 'alice', password: 'hunter2' } },
    ]) {
      const doc = structuredClone(realWeeklyReportIr()) as unknown as Record<
        string,
        unknown
      >;
      const nodes = doc.nodes as Array<Record<string, unknown>>;
      for (const node of nodes) {
        if (node.id === 'upload_report') Object.assign(node, smuggle);
      }
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_FIELD');
    }
  });

  it('json literals are workflow content, not secret channels (documented boundary)', () => {
    // A json literal MAY contain arbitrary workflow content — that is the
    // author's responsibility; the SCHEMA guarantee is that secret VALUES can
    // only travel through secret_ref ports. This documents the honest
    // boundary rather than pretending string content is detectable.
    const doc = structuredClone(realWeeklyReportIr()) as {
      dataBindings: Array<{ source: { kind: string; literal?: { type: string; value: unknown } } }>;
    };
    for (const binding of doc.dataBindings) {
      if (binding.source.kind === 'node_output') {
        binding.source = {
          kind: 'literal',
          literal: { type: 'json', value: { note: 'configuration payload' } },
        } as typeof binding.source;
      }
    }
    expect(() => validateWorkflowIR(doc)).toThrow(/TYPE_MISMATCH/);
    // read_crm_export.engagements (json) can be replaced by a json literal:
    const doc2 = structuredClone(realWeeklyReportIr()) as unknown as {
      dataBindings: Array<Record<string, unknown>>;
    };
    for (const binding of doc2.dataBindings) {
      const source = binding.source as Record<string, unknown>;
      if (source.kind === 'node_output' && source.port === 'engagements') {
        binding.source = {
          kind: 'literal',
          literal: { type: 'json', value: { note: 'configuration payload' } },
        };
      }
    }
    const ir = validateWorkflowIR(doc2);
    expect(serializeWorkflowIR(ir)).toContain('configuration payload');
  });
});

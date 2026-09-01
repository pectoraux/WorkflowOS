import { describe, it, expect } from 'vitest';
import { validateWorkflowIR } from '../../src/workflow-ir/index.js';
import type { WorkflowIR } from '../../src/workflow-ir/index.js';
import { minimalIr, realWeeklyReportIr, expectWorkflowIRError } from './fixtures.js';

/**
 * V2-003 — typed data-binding validation tests.
 *
 * Work Order mapping ("Required regressions" → "typed binding rejection"):
 * data bindings are strictly typed — source type must equal target type with
 * no coercion; every node input is bound exactly once; unknown ports, dead
 * workflow inputs/outputs and ambiguous multi-bindings fail closed.
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

type LooseBinding = Record<string, unknown>;

function bindingsOf(m: Record<string, unknown>): LooseBinding[] {
  return m.dataBindings as LooseBinding[];
}

function findBinding(m: Record<string, unknown>, node: string, port: string): LooseBinding {
  const binding = bindingsOf(m).find(
    (b) =>
      (b.target as Record<string, unknown>).kind === 'node_input' &&
      (b.target as Record<string, unknown>).node === node &&
      (b.target as Record<string, unknown>).port === port,
  );
  expect(binding, `fixture binding → ${node}.${port} must exist`).toBeDefined();
  return binding!;
}

/** An IR with one typed data path: input "payload" → step.in → output "result". */
function typedDataIr(): WorkflowIR {
  return {
    schemaVersion: 1,
    nodes: [
      { kind: 'start', id: 'start' },
      {
        kind: 'step',
        id: 'transform',
        instruction: 'Transform the payload.',
        executionClass: 'deterministic_api',
        capability: 'filesystem.read',
        inputs: [{ id: 'in', type: 'string' }],
        outputs: [{ id: 'out', type: 'number' }],
      },
      { kind: 'end', id: 'done' },
    ],
    edges: [
      { from: 'start', to: 'transform', kind: 'on_success' },
      { from: 'transform', to: 'done', kind: 'on_success' },
    ],
    dataBindings: [
      {
        source: { kind: 'workflow_input', input: 'payload' },
        target: { kind: 'node_input', node: 'transform', port: 'in' },
      },
      {
        source: { kind: 'node_output', node: 'transform', port: 'out' },
        target: { kind: 'workflow_output', output: 'result' },
      },
    ],
    inputs: [{ id: 'payload', type: 'string' }],
    outputs: [{ id: 'result', type: 'number' }],
    dependencies: [],
    requirements: {
      capabilities: ['filesystem.read'],
      placement: { locality: 'any_supported_node' },
    },
    provenance: { origin: 'authored' },
  };
}

describe('WorkflowIR typed binding validation', () => {
  it('positive control: a fully typed data path validates', () => {
    expect(() => validateWorkflowIR(typedDataIr())).not.toThrow();
  });

  it('positive control: the real workflow data graph validates', () => {
    const ir = validateWorkflowIR(realWeeklyReportIr());
    expect(ir.dataBindings).toHaveLength(11);
  });

  describe('type discrimination (no silent coercion)', () => {
    it('rejects binding a string source into a number input', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        // the NODE input port is number-typed; the literal source is a string
        // (the original mutation retyped the workflow input, which the binding
        // no longer referenced — the mismatch must be on the bound port)
        (m.nodes as Record<string, unknown>[])[1]!.inputs = [{ id: 'in', type: 'number' }];
        findBinding(m, 'transform', 'in').source = { kind: 'literal', literal: { type: 'string', value: '42' } };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'TYPE_MISMATCH');
    });

    it('rejects binding a number literal into a string input', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        findBinding(m, 'transform', 'in').source = {
          kind: 'literal',
          literal: { type: 'number', value: 42 },
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'TYPE_MISMATCH');
    });

    it('rejects binding json into a typed scalar port', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        findBinding(m, 'transform', 'in').source = {
          kind: 'literal',
          literal: { type: 'json', value: { any: 'shape' } },
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'TYPE_MISMATCH');
    });

    it('rejects binding object_ref into json', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        (m.inputs as Record<string, unknown>[])[0]!.type = 'object_ref';
        (m.nodes as Record<string, unknown>[])[1]!.inputs = [{ id: 'in', type: 'json' }];
        findBinding(m, 'transform', 'in').source = {
          kind: 'workflow_input',
          input: 'payload',
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'TYPE_MISMATCH');
    });

    it('rejects binding a list into its element type', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        (m.inputs as Record<string, unknown>[])[0]!.type = { list: 'string' };
        (m.nodes as Record<string, unknown>[])[1]!.inputs = [{ id: 'in', type: 'string' }];
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'TYPE_MISMATCH');
    });

    it('rejects a list element type mismatch', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        (m.inputs as Record<string, unknown>[])[0]!.type = { list: 'string' };
        (m.nodes as Record<string, unknown>[])[1]!.inputs = [
          { id: 'in', type: { list: 'number' } },
        ];
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'TYPE_MISMATCH');
    });

    it('rejects a nested record element type mismatch', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        (m.inputs as Record<string, unknown>[])[0]!.type = {
          record: { list: 'string' },
        };
        (m.nodes as Record<string, unknown>[])[1]!.inputs = [
          { id: 'in', type: { record: { list: 'number' } } },
        ];
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'TYPE_MISMATCH');
    });

    it('rejects a list vs record composite mismatch', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        (m.inputs as Record<string, unknown>[])[0]!.type = { list: 'string' };
        (m.nodes as Record<string, unknown>[])[1]!.inputs = [
          { id: 'in', type: { record: 'string' } },
        ];
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'TYPE_MISMATCH');
    });

    it('rejects secret_ref → string (secrets are never silently coerced)', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        (m.inputs as Record<string, unknown>[]).push({ id: 'extra_token', type: 'secret_ref' });
        findBinding(m, 'read_crm_export', 'week').source = {
          kind: 'workflow_input',
          input: 'extra_token',
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'TYPE_MISMATCH');
    });

    it('accepts an exact deep composite type match (list of records of strings)', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        (m.inputs as Record<string, unknown>[])[0]!.type = { list: { record: 'string' } };
        (m.nodes as Record<string, unknown>[])[1]!.inputs = [
          { id: 'in', type: { list: { record: 'string' } } },
        ];
        findBinding(m, 'transform', 'in').source = {
          kind: 'workflow_input',
          input: 'payload',
        };
      });
      expect(() => validateWorkflowIR(doc)).not.toThrow();
    });
  });

  describe('binding endpoint integrity', () => {
    it('rejects a binding from an undeclared workflow input', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        findBinding(m, 'transform', 'in').source = {
          kind: 'workflow_input',
          input: 'no_such_input',
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_BINDING');
    });

    it('rejects a binding from an unknown node output', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        findBinding(m, 'transform', 'in').source = {
          kind: 'node_output',
          node: 'ghost',
          port: 'out',
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_NODE');
    });

    it('rejects a binding from an undeclared output port', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        findBinding(m, 'transform', 'in').source = {
          kind: 'node_output',
          node: 'transform',
          port: 'no_such_port',
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_PORT');
    });

    it('rejects a binding into an undeclared input port', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        findBinding(m, 'transform', 'in').target = {
          kind: 'node_input',
          node: 'transform',
          port: 'no_such_port',
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_PORT');
    });

    it('rejects a binding into an undeclared workflow output', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        // the binding SOURCED from transform.out targets the workflow output;
        // findBinding matches by TARGET port, so find it by its source side
        const binding = bindingsOf(m).find(
          (b) => (b.source as Record<string, unknown>).kind === 'node_output',
        )!;
        binding.target = { kind: 'workflow_output', output: 'no_such_output' };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_BINDING');
    });

    it('rejects a binding sourced from a node_output of a decision node (decisions have no outputs)', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        findBinding(m, 'recipient_check', 'urgency').source = {
          kind: 'node_output',
          node: 'recipient_check',
          port: 'urgency',
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_BINDING');
    });

    it('rejects a binding targeted at a start or end node (they have no data ports)', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        findBinding(m, 'transform', 'in').target = {
          kind: 'node_input',
          node: 'start',
          port: 'in',
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_BINDING');
    });

    it('rejects malformed binding objects', () => {
      for (const bad of [
        { source: { kind: 'literal', literal: { type: 'string', value: 'x' } } }, // no target
        { target: { kind: 'workflow_output', output: 'result' } }, // no source
        {
          source: { kind: 'telepathy' },
          target: { kind: 'workflow_output', output: 'result' },
        },
        {
          source: { kind: 'literal', literal: { type: 'string', value: 'x' } },
          target: { kind: 'broadcast' },
        },
      ]) {
        const doc = rawMut(typedDataIr(), (m) => {
          bindingsOf(m)[0] = bad;
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_BINDING');
      }
    });

    it('rejects unknown fields on a binding', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        bindingsOf(m)[0]!.transform = 'presentation-hint';
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_FIELD');
    });
  });

  describe('exactly-once binding semantics', () => {
    it('rejects an unbound node input port', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        m.dataBindings = bindingsOf(m).filter(
          (b) => !((b.target as Record<string, unknown>).port === 'in'),
        );
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNBOUND_INPUT');
    });

    it('rejects a node input port bound twice (ambiguous input)', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        bindingsOf(m).push({
          source: { kind: 'literal', literal: { type: 'string', value: 'x' } },
          target: { kind: 'node_input', node: 'transform', port: 'in' },
        });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'DUPLICATE_INPUT_BINDING');
    });

    it('rejects an unbound workflow output', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        m.dataBindings = bindingsOf(m).filter(
          (b) => (b.target as Record<string, unknown>).kind === 'node_input',
        );
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNBOUND_INPUT');
    });

    it('rejects a workflow output bound twice', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        bindingsOf(m).push({
          source: { kind: 'literal', literal: { type: 'number', value: 1 } },
          target: { kind: 'workflow_output', output: 'result' },
        });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'DUPLICATE_INPUT_BINDING');
    });

    it('rejects a workflow input that is never bound (dead interface declaration)', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        (m.inputs as Record<string, unknown>[]).push({ id: 'unused_input', type: 'string' });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNBOUND_WORKFLOW_INPUT');
    });
  });

  describe('literal validation', () => {
    it('rejects a literal whose value does not conform to its declared type', () => {
      for (const bad of [
        { type: 'string', value: 42 },
        { type: 'number', value: '42' },
        { type: 'boolean', value: 'true' },
        { type: 'json', value: undefined },
      ]) {
        const doc = rawMut(typedDataIr(), (m) => {
          (m.inputs as Record<string, unknown>[])[0]!.type =
            (bad as Record<string, unknown>).type;
          (m.nodes as Record<string, unknown>[])[1]!.inputs = [
            { id: 'in', type: (bad as Record<string, unknown>).type },
          ];
          findBinding(m, 'transform', 'in').source = { kind: 'literal', literal: bad };
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_LITERAL');
      }
    });

    it('rejects a literal with a composite or reference type (only scalar/json literals exist)', () => {
      for (const badType of ['object_ref', 'user_ref', 'device_ref']) {
        const doc = rawMut(typedDataIr(), (m) => {
          (m.inputs as Record<string, unknown>[])[0]!.type = badType;
          (m.nodes as Record<string, unknown>[])[1]!.inputs = [
            { id: 'in', type: badType },
          ];
          findBinding(m, 'transform', 'in').source = {
            kind: 'literal',
            literal: { type: badType, value: 'ref-1' },
          };
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_LITERAL');
      }
      const listDoc = rawMut(typedDataIr(), (m) => {
        (m.inputs as Record<string, unknown>[])[0]!.type = { list: 'string' };
        (m.nodes as Record<string, unknown>[])[1]!.inputs = [
          { id: 'in', type: { list: 'string' } },
        ];
        findBinding(m, 'transform', 'in').source = {
          kind: 'literal',
          literal: { type: { list: 'string' } as unknown as string, value: ['x'] },
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(listDoc), 'INVALID_LITERAL');
    });

    it('rejects non-finite and negative-zero numeric literals (determinism)', () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0]) {
        const doc = rawMut(typedDataIr(), (m) => {
          (m.inputs as Record<string, unknown>[])[0]!.type = 'number';
          (m.nodes as Record<string, unknown>[])[1]!.inputs = [
            { id: 'in', type: 'number' },
          ];
          findBinding(m, 'transform', 'in').source = {
            kind: 'literal',
            literal: { type: 'number', value: bad },
          };
        });
        expectWorkflowIRError(
          () => validateWorkflowIR(doc),
          'INVALID_LITERAL',
          `literal ${String(bad)}`,
        );
      }
    });

    it('accepts a correctly typed literal', () => {
      const doc = rawMut(typedDataIr(), (m) => {
        findBinding(m, 'transform', 'in').source = {
          kind: 'literal',
          literal: { type: 'string', value: 'direct literal' },
        };
        // 'payload' is no longer referenced by any binding — a dead workflow
        // input would be UNBOUND_WORKFLOW_INPUT, so drop the declaration too
        m.inputs = (m.inputs as Record<string, unknown>[]).filter(
          (input) => input.id !== 'payload',
        );
      });
      const ir = validateWorkflowIR(doc);
      const binding = ir.dataBindings.find(
        (b) =>
          b.target.kind === 'node_input' &&
          b.target.node === 'transform' &&
          b.target.port === 'in',
      );
      expect(binding?.source).toEqual({
        kind: 'literal',
        literal: { type: 'string', value: 'direct literal' },
      });
    });
  });

  describe('decision input and condition typing', () => {
    it('rejects a decision with more than one input port', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        (m.nodes as Record<string, unknown>[]).forEach((n) => {
          if (n.id === 'recipient_check') n.inputs = [
            { id: 'urgency', type: 'string' },
            { id: 'second', type: 'string' },
          ];
        });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_DECISION');
    });

    it('rejects a decision with output ports', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        (m.nodes as Record<string, unknown>[]).forEach((n) => {
          if (n.id === 'recipient_check') n.outputs = [{ id: 'out', type: 'string' }];
        });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_DECISION');
    });

    it('rejects an equals condition whose value does not conform to the input type', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        (m.nodes as Record<string, unknown>[]).forEach((n) => {
          if (n.id === 'recipient_check') n.cases = [
            { id: 'urgent', condition: { kind: 'equals', value: 42 } },
          ];
        });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONDITION');
    });

    it('rejects an equals condition on a reference-typed input', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        (m.inputs as Record<string, unknown>[]).forEach((input) => {
          if (input.id === 'urgency') input.type = 'secret_ref';
        });
        (m.nodes as Record<string, unknown>[]).forEach((n) => {
          if (n.id === 'recipient_check') n.inputs = [{ id: 'urgency', type: 'secret_ref' }];
        });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CONDITION');
    });
  });

  it('unknown binding source kinds fail closed (no implicit side effects)', () => {
    const doc = rawMut(minimalIr(), (m) => {
      m.dataBindings = [
        {
          source: { kind: 'environment_variable', name: 'HOME' },
          target: { kind: 'workflow_output', output: 'x' },
        },
      ];
    });
    expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_BINDING');
  });
});

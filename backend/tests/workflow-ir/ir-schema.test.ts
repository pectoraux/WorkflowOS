import { describe, it, expect } from 'vitest';
import {
  validateWorkflowIR,
  deserializeWorkflowIR,
  WorkflowIRError,
  WORKFLOW_IR_ERROR_REASONS,
  WORKFLOW_IR_SCHEMA_VERSION,
  WORKFLOW_IR_EXECUTION_CLASSES,
  WORKFLOW_IR_PLACEMENT_IDS,
  WORKFLOW_IR_VALUE_TYPE_TAGS,
  WORKFLOW_IR_DIGEST_ALGORITHM,
} from '../../src/workflow-ir/index.js';
import {
  minimalIr,
  realWeeklyReportIr,
  expectWorkflowIRError,
} from './fixtures.js';
import type {
  DeepMutableWorkflowIR,
  WorkflowIR,
  WorkflowIRErrorReason,
} from '../../src/workflow-ir/index.js';

/**
 * V2-003 — WorkflowIR schema validation tests.
 *
 * Work Order mapping (V2-003.md "Required regressions" → "schema validation
 * tests"):
 * - the typed schema is validated strictly: unknown fields, missing fields,
 *   wrong field shapes, malformed identifiers/enums all fail closed;
 * - a prompt, a recording, a browser trace, model memory and a TeachingSession
 *   are NOT WorkflowIR (constitution §3) — they are rejected as inputs;
 * - repository/marketplace metadata (constitution §3 + registry digest rules)
 *   is not part of the IR schema surface.
 */

/** Mutate a copy of `doc`, treating it as a loose record (for invalid shapes). */
function rawMut(doc: WorkflowIR, edit: (m: Record<string, unknown>) => void): unknown {
  const clone: Record<string, unknown> = structuredClone(doc) as unknown as Record<
    string,
    unknown
  >;
  edit(clone);
  return clone;
}

describe('WorkflowIR schema validation', () => {
  it('accepts the minimal well-formed IR and returns the canonical form', () => {
    const ir = validateWorkflowIR(minimalIr());
    expect(ir.schemaVersion).toBe(WORKFLOW_IR_SCHEMA_VERSION);
    expect(ir.nodes.map((n) => n.id)).toEqual(['do_work', 'done', 'start']);
    expect(ir.requirements.capabilities).toEqual(['filesystem.read']);
  });

  it('accepts the real weekly-report workflow', () => {
    const ir = validateWorkflowIR(realWeeklyReportIr());
    expect(ir.nodes).toHaveLength(10);
    expect(ir.edges).toHaveLength(11);
    expect(ir.dataBindings).toHaveLength(11);
  });

  it('pins the frozen error-reason vocabulary', () => {
    // Adding/renaming a reason is a breaking schema change and must be a
    // deliberate act — this test pins the exact sorted vocabulary.
    expect(WORKFLOW_IR_ERROR_REASONS).toEqual([
      'AMBIGUOUS_CONTROL',
      'CAPABILITY_ALIAS',
      'CONTROL_CYCLE',
      'DUPLICATE_EDGE',
      'DUPLICATE_INPUT_BINDING',
      'DUPLICATE_NODE_ID',
      'DUPLICATE_PORT_ID',
      'END_NODE_INVALID',
      'INVALID_BINDING',
      'INVALID_CAPABILITY',
      'INVALID_CONDITION',
      'INVALID_CONTROL_EDGE',
      'INVALID_DECISION',
      'INVALID_DEPENDENCY',
      'INVALID_EDGE',
      'INVALID_EXECUTION_CLASS',
      'INVALID_FIELD',
      'INVALID_INSTRUCTION',
      'INVALID_LITERAL',
      'INVALID_NODE_ID',
      'INVALID_NODE_SHAPE',
      'INVALID_PLACEMENT',
      'INVALID_PROVENANCE',
      'INVALID_SCHEMA_VERSION',
      'MISSING_FIELD',
      'NOT_A_WORKFLOW_IR',
      'PARSE_ERROR',
      'PLACEMENT_CONTRADICTION',
      'SECRET_LITERAL_FORBIDDEN',
      'START_NODE_INVALID',
      'TYPE_MISMATCH',
      'UNBOUND_INPUT',
      'UNBOUND_WORKFLOW_INPUT',
      'UNKNOWN_FIELD',
      'UNKNOWN_NODE',
      'UNKNOWN_PORT',
      'UNREACHABLE_NODE',
      'UNSUPPORTED_SCHEMA_VERSION',
    ]);
    expect(new Set(WORKFLOW_IR_ERROR_REASONS).size).toBe(WORKFLOW_IR_ERROR_REASONS.length);
  });

  it('pins the registry-derived vocabularies', () => {
    expect(WORKFLOW_IR_EXECUTION_CLASSES).toEqual([
      'deterministic_api',
      'agentic_computer_use',
      'human',
      'subworkflow',
    ]);
    expect(WORKFLOW_IR_PLACEMENT_IDS).toEqual([
      'device_local',
      'device_preferred',
      'cloud_allowed',
      'cloud_preferred',
      'cloud_required',
      'any_supported_node',
    ]);
    expect(WORKFLOW_IR_VALUE_TYPE_TAGS).toEqual([
      'string',
      'number',
      'boolean',
      'json',
      'object_ref',
      'secret_ref',
      'user_ref',
      'device_ref',
    ]);
    expect(WORKFLOW_IR_DIGEST_ALGORITHM).toBe('SHA-256');
  });

  describe('a prompt is not a WorkflowIR (constitution §3)', () => {
    it('rejects a bare prompt string', () => {
      expectWorkflowIRError(
        () => validateWorkflowIR('Fix the browser and upload the report.'),
        'NOT_A_WORKFLOW_IR',
      );
    });

    it('rejects a JSON-encoded prompt string', () => {
      expectWorkflowIRError(
        () => deserializeWorkflowIR('"Fix the browser and upload the report."'),
        'NOT_A_WORKFLOW_IR',
      );
    });

    it('rejects a prompt object (model conversation / model memory)', () => {
      expectWorkflowIRError(
        () =>
          validateWorkflowIR({
            prompt: 'Fetch the report and email it.',
            model: 'any-model',
            messages: [{ role: 'user', content: 'Fetch the report and email it.' }],
          }),
        'NOT_A_WORKFLOW_IR',
      );
    });

    it('rejects a screen recording / raw interaction capture', () => {
      expectWorkflowIRError(
        () =>
          validateWorkflowIR({
            frames: ['frame-001.png', 'frame-002.png'],
            events: [
              { type: 'mousemove', x: 120, y: 40 },
              { type: 'click', x: 120, y: 40 },
            ],
            duration_ms: 91827,
          }),
        'NOT_A_WORKFLOW_IR',
      );
    });

    it('rejects a browser trace', () => {
      expectWorkflowIRError(
        () =>
          validateWorkflowIR({
            trace: [
              { url: 'https://example.test/report', action: 'click', selector: '#upload' },
            ],
          }),
        'NOT_A_WORKFLOW_IR',
      );
    });

    it('rejects a TeachingSession', () => {
      expectWorkflowIRError(
        () =>
          validateWorkflowIR({
            sessionId: 'teach-001',
            learner: 'user-alice',
            checkpoints: ['step-1', 'step-2'],
            learnerState: { completed: ['step-1'] },
          }),
        'NOT_A_WORKFLOW_IR',
      );
    });

    it('rejects a compiled artifact manifest', () => {
      expectWorkflowIRError(
        () =>
          validateWorkflowIR({
            artifactId: 'compiled-xyz',
            entrypoint: 'main.bin',
            target: 'wasm-unknown',
          }),
        'NOT_A_WORKFLOW_IR',
      );
    });

    it('rejects null, arrays and top-level primitives', () => {
      expectWorkflowIRError(() => validateWorkflowIR(null), 'NOT_A_WORKFLOW_IR');
      expectWorkflowIRError(() => validateWorkflowIR([minimalIr()]), 'NOT_A_WORKFLOW_IR');
      expectWorkflowIRError(() => validateWorkflowIR(42), 'NOT_A_WORKFLOW_IR');
      expectWorkflowIRError(() => validateWorkflowIR(true), 'NOT_A_WORKFLOW_IR');
    });
  });

  describe('strict top-level shape', () => {
    const requiredFields = [
      'schemaVersion',
      'nodes',
      'edges',
      'dataBindings',
      'inputs',
      'outputs',
      'dependencies',
      'requirements',
      'provenance',
    ] as const;

    for (const field of requiredFields) {
      it(`rejects a missing required field: ${field}`, () => {
        const doc = rawMut(minimalIr(), (m) => {
          delete m[field];
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'MISSING_FIELD');
      });
    }

    it('rejects unknown top-level fields (repository/marketplace metadata is not IR)', () => {
      for (const extra of [
        'title',
        'description',
        'owner',
        'tenant',
        'visibility',
        'marketplacePricing',
        'currentVersion',
        'installationPolicy',
        'uiState',
      ]) {
        const doc = rawMut(minimalIr(), (m) => {
          m[extra] = 'not-part-of-the-ir';
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_FIELD');
      }
    });

    it('rejects non-array collection fields', () => {
      const doc = rawMut(minimalIr(), (m) => {
        m.nodes = 'not-an-array';
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_FIELD');
    });
  });

  describe('schema version field', () => {
    it('rejects a non-integer schemaVersion', () => {
      for (const bad of ['1', 1.5, 0, -1, null]) {
        const doc = rawMut(minimalIr(), (m) => {
          m.schemaVersion = bad;
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_SCHEMA_VERSION');
      }
    });

    it('rejects an unsupported (future) schemaVersion, fail closed', () => {
      const doc = rawMut(minimalIr(), (m) => {
        m.schemaVersion = 2;
      });
      const err = expectWorkflowIRError(
        () => validateWorkflowIR(doc),
        'UNSUPPORTED_SCHEMA_VERSION',
      );
      expect(err.message).toContain('negotiate');
    });

    it('deserialize accepts a v1 document under a consumer claiming v1+v2 support', () => {
      const text = JSON.stringify(minimalIr());
      const ir = deserializeWorkflowIR(text, { supportedSchemaVersions: [1, 2] });
      expect(ir.schemaVersion).toBe(1);
    });
  });

  describe('node shape validation', () => {
    it('rejects malformed node ids', () => {
      for (const badId of ['Bad-ID', '2fast', 'has space', '', 'a'.repeat(65), 'do-work']) {
        const doc = rawMut(minimalIr(), (m) => {
          (m.nodes as Record<string, unknown>[])[1]!.id = badId;
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_NODE_ID');
      }
    });

    it('rejects duplicate node ids', () => {
      const doc = rawMut(minimalIr(), (m) => {
        // minimalIr nodes: [start, do_work, done] — renaming the END node to
        // the step's id collides (a self-identical 'done' would be a no-op)
        (m.nodes as Record<string, unknown>[])[2]!.id = 'do_work';
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'DUPLICATE_NODE_ID');
    });

    it('rejects unknown node kinds', () => {
      const doc = rawMut(minimalIr(), (m) => {
        (m.nodes as Record<string, unknown>[])[1]!.kind = 'task';
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_FIELD');
    });

    it('rejects an empty or whitespace instruction', () => {
      for (const bad of ['', '   ']) {
        const doc = rawMut(minimalIr(), (m) => {
          (m.nodes as Record<string, unknown>[])[1]!.instruction = bad;
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_INSTRUCTION');
      }
    });

    it('rejects a non-string instruction', () => {
      const doc = rawMut(minimalIr(), (m) => {
        (m.nodes as Record<string, unknown>[])[1]!.instruction = 42;
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_INSTRUCTION');
    });

    it('rejects non-canonical execution classes', () => {
      for (const bad of ['api', 'deterministic-api', 'gui_automation', 'computer_use', 'script']) {
        const doc = rawMut(minimalIr(), (m) => {
          (m.nodes as Record<string, unknown>[])[1]!.executionClass = bad;
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_EXECUTION_CLASS');
      }
    });

    it('rejects malformed capability identifiers on steps', () => {
      for (const bad of ['', 'Browser.Click', 'browser', 'browser..click', '.click', 'browser.click!']) {
        const doc = rawMut(minimalIr(), (m) => {
          (m.nodes as Record<string, unknown>[])[1]!.capability = bad;
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_CAPABILITY');
      }
    });

    it('rejects unknown step fields (fail closed, no silent extension)', () => {
      for (const extra of ['timeoutMs', 'retriesLeft', 'idempotencyKey', 'memo']) {
        const doc = rawMut(minimalIr(), (m) => {
          (m.nodes as Record<string, unknown>[])[1]![extra] = 'unknown';
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_FIELD');
      }
    });

    it('rejects malformed failure.retry values', () => {
      for (const bad of [-1, 11, 1.5, '2']) {
        const doc = rawMut(minimalIr(), (m) => {
          (m.nodes as Record<string, unknown>[])[1]!.failure = { retry: bad };
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_FIELD');
      }
    });

    it('accepts failure.retry at the documented maximum boundary', () => {
      const doc = structuredClone(minimalIr()) as DeepMutableWorkflowIR;
      const step = doc.nodes.find((n) => n.kind === 'step');
      expect(step && step.kind === 'step').toBe(true);
      if (step && step.kind === 'step') step.failure = { retry: 10 };
      // canonical nodes are sorted by id (do_work < done < start) — address the
      // step by id, not by authored index
      const canonical = validateWorkflowIR(doc);
      expect(canonical.nodes.find((n) => n.id === 'do_work')).toMatchObject({
        failure: { retry: 10 },
      });
    });

    it('rejects duplicate port ids within one node', () => {
      const doc = structuredClone(minimalIr()) as DeepMutableWorkflowIR;
      const step = doc.nodes.find((n) => n.kind === 'step');
      if (step && step.kind === 'step') {
        step.inputs = [
          { id: 'in', type: 'string' },
          { id: 'in', type: 'number' },
        ];
      }
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'DUPLICATE_PORT_ID');
    });

    it('rejects unknown port fields', () => {
      const doc = rawMut(minimalIr(), (m) => {
        (m.nodes as Record<string, unknown>[])[1]!.inputs = [
          { id: 'in', type: 'string', optional: true },
        ];
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_FIELD');
    });

    it('rejects invalid value types', () => {
      for (const bad of ['text', 'integer', 'object', { list: 'text' }, { list: 3 }, { set: 'string' }]) {
        const doc = rawMut(minimalIr(), (m) => {
          (m.nodes as Record<string, unknown>[])[1]!.inputs = [
            { id: 'in', type: bad },
          ];
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_FIELD');
      }
    });

    it('rejects unknown fields on start and end nodes', () => {
      for (const extra of ['instruction', 'inputs', 'outputs', 'next', 'entryCondition']) {
        const doc = rawMut(minimalIr(), (m) => {
          (m.nodes as Record<string, unknown>[])[2]![extra] = 'unknown';
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_FIELD');
      }
    });

    it('rejects an invalid end outcome', () => {
      const doc = rawMut(minimalIr(), (m) => {
        (m.nodes as Record<string, unknown>[])[2]!.outcome = 'cancelled';
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_FIELD');
    });

    it('rejects invalid provenance', () => {
      const cases: Array<[string, unknown, WorkflowIRErrorReason]> = [
        ['unknown origin', { origin: 'teaching' }, 'INVALID_PROVENANCE'],
        ['empty generator', { origin: 'authored', generator: '' }, 'INVALID_PROVENANCE'],
        [
          // sourceReferences is a schema-declared SET (sorted + de-duplicated
          // during canonicalization — see ir-canonicalization/ir-digest), so a
          // duplicate entry collapses to the same semantics and is NOT
          // invalid; the genuinely invalid shape here is a non-array.
          'non-array source references',
          { origin: 'authored', sourceReferences: 'brief-w35' },
          'INVALID_PROVENANCE',
        ],
        [
          'malformed source reference',
          { origin: 'authored', sourceReferences: ['bad ref!'] },
          'INVALID_PROVENANCE',
        ],
      ];
      for (const [label, provenance, reason] of cases) {
        const doc = rawMut(minimalIr(), (m) => {
          m.provenance = provenance;
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), reason, label);
      }
    });

    it('rejects unknown provenance fields (raw capture is not embeddable)', () => {
      const doc = rawMut(minimalIr(), (m) => {
        (m.provenance as Record<string, unknown>).recording = 'data:video/mp4;base64,AAAA';
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_FIELD');
    });

    it('rejects malformed subworkflow dependencies', () => {
      const real = realWeeklyReportIr();
      for (const bad of ['', 'UPPER', 'has space']) {
        const doc = rawMut(real, (m) => {
          (m.dependencies as Record<string, unknown>[])[0]!.workflowVersionId = bad;
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_DEPENDENCY');
      }
      const dup = rawMut(real, (m) => {
        (m.dependencies as Record<string, unknown>[]).push(
          structuredClone((m.dependencies as Record<string, unknown>[])[0]!),
        );
      });
      expectWorkflowIRError(() => validateWorkflowIR(dup), 'INVALID_DEPENDENCY');
    });

    it('rejects a declared dependency that no subworkflow step uses', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        (m.dependencies as Record<string, unknown>[]).push({
          id: 'unused_subworkflow',
          workflowVersionId: 'wf-unused@v1',
        });
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_DEPENDENCY');
    });

    it('rejects a subworkflow step referencing an undeclared dependency', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        for (const node of m.nodes as Record<string, unknown>[]) {
          if (node.executionClass === 'subworkflow') node.dependency = 'not_declared';
        }
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_DEPENDENCY');
    });
  });

  describe('step class/field combination rules', () => {
    it('rejects a deterministic_api step without a capability', () => {
      const doc = rawMut(minimalIr(), (m) => {
        delete (m.nodes as Record<string, unknown>[])[1]!.capability;
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_NODE_SHAPE');
    });

    it('rejects an agentic step without a capability', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        for (const node of m.nodes as Record<string, unknown>[]) {
          if (node.executionClass === 'agentic_computer_use') delete node.capability;
        }
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_NODE_SHAPE');
    });

    it('rejects a capability on a human step', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        for (const node of m.nodes as Record<string, unknown>[]) {
          if (node.executionClass === 'human') node.capability = 'filesystem.read';
        }
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_NODE_SHAPE');
    });

    it('rejects a dependency on a non-subworkflow step', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        for (const node of m.nodes as Record<string, unknown>[]) {
          if (node.executionClass === 'deterministic_api' && node.capability === 'browser.upload')
            node.dependency = 'archive_subworkflow';
        }
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_NODE_SHAPE');
    });

    it('rejects requestApproval on a non-human step', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        for (const node of m.nodes as Record<string, unknown>[]) {
          if (node.executionClass === 'deterministic_api' && node.capability === 'browser.upload')
            node.requestApproval = true;
        }
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_NODE_SHAPE');
    });

    it('rejects failure retry on an approval step', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        for (const node of m.nodes as Record<string, unknown>[]) {
          if (node.executionClass === 'human' && node.requestApproval === true)
            node.failure = { retry: 2 };
        }
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_NODE_SHAPE');
    });
  });

  describe('requirements and placement fields', () => {
    it('rejects unknown requirements fields', () => {
      const doc = rawMut(minimalIr(), (m) => {
        (m.requirements as Record<string, unknown>).authorization = 'not-part-of-the-ir';
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_FIELD');
    });

    it('rejects unknown placement fields', () => {
      const doc = rawMut(minimalIr(), (m) => {
        (m.requirements as Record<string, unknown>).placement = {
          locality: 'any_supported_node',
          privacy: 'strict',
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_FIELD');
    });

    it('rejects a non-canonical placement locality', () => {
      for (const bad of ['local', 'on_device', 'cloud', 'browser', 'mobile']) {
        const doc = rawMut(minimalIr(), (m) => {
          (m.requirements as Record<string, unknown>).placement = { locality: bad };
        });
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_PLACEMENT');
      }
    });

    it('rejects a non-canonical disallowed placement id', () => {
      const doc = rawMut(minimalIr(), (m) => {
        (m.requirements as Record<string, unknown>).placement = {
          locality: 'any_supported_node',
          disallowed: ['somewhere_else'],
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_PLACEMENT');
    });

    it('rejects contradictory placement constraints, fail closed', () => {
      const doc = rawMut(minimalIr(), (m) => {
        (m.requirements as Record<string, unknown>).placement = {
          locality: 'any_supported_node',
          disallowed: ['any_supported_node'],
        };
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'PLACEMENT_CONTRADICTION');
    });

    it('rejects an authored capabilities set that disagrees with the derived set', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        (m.requirements as Record<string, unknown>).capabilities = [
          'messaging.send',
          'browser.upload',
          'spreadsheet.read',
          'filesystem.write',
          'github.repository.read', // not used by any step
        ];
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_FIELD');
    });
  });

  it('WorkflowIRError is an Error subclass with a stable name and message shape', () => {
    const err = new WorkflowIRError('TYPE_MISMATCH', 'detail');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WorkflowIRError');
    expect(err.reason).toBe('TYPE_MISMATCH');
    expect(err.message).toBe('TYPE_MISMATCH: detail');
  });

  it('canonical form is deeply frozen (the IR is an immutable semantic object)', () => {
    const ir = validateWorkflowIR(realWeeklyReportIr());
    const mutableView = ir as unknown as DeepMutableWorkflowIR;
    expect(Object.isFrozen(ir)).toBe(true);
    expect(Object.isFrozen(ir.nodes)).toBe(true);
    expect(Object.isFrozen(ir.nodes[0])).toBe(true);
    expect(() => {
      mutableView.nodes[0]!.id = 'mutated';
    }).toThrow();
  });
});

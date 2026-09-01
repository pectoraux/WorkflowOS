import { describe, it, expect } from 'vitest';
import {
  deserializeWorkflowIR,
  serializeWorkflowIR,
  negotiateWorkflowIRSchemaVersion,
  WORKFLOW_IR_SCHEMA_VERSION,
  SUPPORTED_WORKFLOW_IR_SCHEMA_VERSIONS,
} from '../../src/workflow-ir/index.js';
import { minimalIr, expectWorkflowIRError } from './fixtures.js';

/**
 * V2-003 — compatibility and version negotiation tests.
 *
 * Work Order mapping ("Must deliver" → "compatibility/version negotiation";
 * "Required regressions" → "version compatibility"):
 *
 * - the library interprets exactly its supported schema versions — a document
 *   from a NEWER schema fails closed (UNSUPPORTED_SCHEMA_VERSION) and is never
 *   silently reinterpretated;
 * - `negotiateWorkflowIRSchemaVersion` is the protocol-level advisory:
 *   exact match, backward consumption (older producer, newer consumer), and
 *   incompatible (producer newer than every consumer version);
 * - the schemaVersion field is version-affecting semantic metadata.
 */
describe('WorkflowIR compatibility and version negotiation', () => {
  it('pins the library version constants', () => {
    expect(WORKFLOW_IR_SCHEMA_VERSION).toBe(1);
    expect(SUPPORTED_WORKFLOW_IR_SCHEMA_VERSIONS).toEqual([1]);
  });

  describe('negotiation function', () => {
    it('reports exact support when the consumer lists the producer version', () => {
      expect(negotiateWorkflowIRSchemaVersion(1, [1])).toEqual({
        status: 'compatible',
        mode: 'exact',
      });
      expect(negotiateWorkflowIRSchemaVersion(2, [1, 2, 3])).toEqual({
        status: 'compatible',
        mode: 'exact',
      });
    });

    it('reports backward support when the producer is older than the consumer maximum', () => {
      // backward mode = the consumer speaks only NEWER versions: the producer
      // version is not natively listed, so consumption relies on the newer
      // consumer's backward compatibility. (A consumer that LISTS the producer
      // version is 'exact' even when it also speaks newer ones — see the
      // exact-support case negotiate(2, [1, 2, 3]).)
      expect(negotiateWorkflowIRSchemaVersion(1, [2, 3])).toEqual({
        status: 'compatible',
        mode: 'backward',
      });
      expect(negotiateWorkflowIRSchemaVersion(1, [2])).toEqual({
        status: 'compatible',
        mode: 'backward',
      });
    });

    it('reports incompatible when the producer is newer than every consumer version', () => {
      expect(negotiateWorkflowIRSchemaVersion(2, [1])).toEqual({
        status: 'incompatible',
        reason: 'producer_newer_than_consumer',
      });
      expect(negotiateWorkflowIRSchemaVersion(5, [1, 2])).toEqual({
        status: 'incompatible',
        reason: 'producer_newer_than_consumer',
      });
    });

    it('fails closed on an empty consumer set', () => {
      expect(negotiateWorkflowIRSchemaVersion(1, [])).toEqual({
        status: 'incompatible',
        reason: 'invalid_consumer_set',
      });
    });

    it('fails closed on malformed versions (non-positive integers)', () => {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => negotiateWorkflowIRSchemaVersion(bad, [1])).toThrow();
      }
      expect(() => negotiateWorkflowIRSchemaVersion(1, [0, 2])).toThrow();
      expect(() => negotiateWorkflowIRSchemaVersion(1, ['1'] as unknown as number[])).toThrow();
    });

    it('is deterministic across repeated calls', () => {
      const first = negotiateWorkflowIRSchemaVersion(1, [1, 2]);
      const second = negotiateWorkflowIRSchemaVersion(1, [1, 2]);
      expect(second).toEqual(first);
    });
  });

  describe('deserialization boundary (the enforced side of negotiation)', () => {
    it('accepts the supported v1 schema', () => {
      const ir = deserializeWorkflowIR(serializeWorkflowIR(minimalIr()));
      expect(ir.schemaVersion).toBe(1);
    });

    it('rejects a future schemaVersion — fail closed, never silently reinterpreted', () => {
      const futureDoc = JSON.stringify(minimalIr()).replace('"schemaVersion":1', '"schemaVersion":2');
      const err = expectWorkflowIRError(
        () => deserializeWorkflowIR(futureDoc),
        'UNSUPPORTED_SCHEMA_VERSION',
      );
      expect(err.message).toContain('negotiate');
    });

    it('rejects a future schemaVersion even when the caller claims support for it', () => {
      // the CALLER may claim v2 support, but THIS library can only interpret
      // the schema versions it implements — the boundary stays honest.
      const futureDoc = JSON.stringify(minimalIr()).replace('"schemaVersion":1', '"schemaVersion":2');
      expectWorkflowIRError(
        () => deserializeWorkflowIR(futureDoc, { supportedSchemaVersions: [1, 2] }),
        'UNSUPPORTED_SCHEMA_VERSION',
      );
    });

    it('accepts an older producer under a consumer that supports only a newer schema (backward)', () => {
      // consumer declares [3] only; producer v1 is older than the consumer
      // maximum → backward-compatible consumption.
      const ir = deserializeWorkflowIR(serializeWorkflowIR(minimalIr()), {
        supportedSchemaVersions: [3],
      });
      expect(ir.schemaVersion).toBe(1);
    });

    it('rejects when the caller set is empty', () => {
      expectWorkflowIRError(
        () =>
          deserializeWorkflowIR(serializeWorkflowIR(minimalIr()), {
            supportedSchemaVersions: [],
          }),
        'UNSUPPORTED_SCHEMA_VERSION',
      );
    });

    it('rejects malformed caller version sets', () => {
      expect(() =>
        deserializeWorkflowIR(serializeWorkflowIR(minimalIr()), {
          supportedSchemaVersions: [0, 2],
        }),
      ).toThrow();
    });
  });
});

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as workflowIr from '../../src/workflow-ir/index.js';
import { validateWorkflowIR } from '../../src/workflow-ir/index.js';
import { realWeeklyReportIr, expectWorkflowIRError } from './fixtures.js';

/**
 * V2-003 — ownership-boundary and no-second-engine discrimination tests.
 *
 * Work Order mapping (V2-003.md "Does not own" + the Architect directive
 * "Do not embed repository persistence semantics or host capabilities into
 * WorkflowIR"; constitution §19 "no second workflow protocol / engine"):
 *
 * - the WorkflowIR domain is a pure semantic authority: its PUBLIC runtime
 *   surface is exactly the frozen validation/serialization/digest/
 *   negotiation API — no execution, persistence, authorization, deployment,
 *   teaching or compilation functions (those belong to V2-005/V2-008,
 *   V2-002, V2-004, V2-013 and V2-007);
 * - the domain source contains no database/SQL/persistence tokens (repository
 *   persistence is V2-002's authoritative surface) and no infrastructure
 *   clients (Fastify/pg/PGlite/Redis);
 * - the domain contains no capability-advertisement / placement-resolution /
 *   node-eligibility logic (Node/Capability/placement is V2-004's surface) —
 *   WorkflowIR carries capability/placement REQUIREMENTS as data only;
 * - the authored capability-requirements set is discriminated in both
 *   disagreement directions (missing + alias), and decision input ports are
 *   subject to exactly-once binding like every other data port.
 */
const BACKEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOMAIN_DIR = join(BACKEND_ROOT, 'src', 'workflow-ir');

/** Mutate a copy of `doc` as a loose record. */
function rawMut(doc: ReturnType<typeof realWeeklyReportIr>, edit: (m: Record<string, unknown>) => void): unknown {
  const clone = structuredClone(doc) as unknown as Record<string, unknown>;
  edit(clone);
  return clone;
}

describe('WorkflowIR ownership boundary and no-second-engine discrimination', () => {
  it('the public runtime surface is exactly the frozen semantic API (pinned)', () => {
    expect(Object.keys(workflowIr).sort()).toEqual([
      'SUPPORTED_WORKFLOW_IR_SCHEMA_VERSIONS',
      'WORKFLOW_IR_CANONICAL_CAPABILITIES',
      'WORKFLOW_IR_CAPABILITY_ALIASES',
      'WORKFLOW_IR_DIGEST_ALGORITHM',
      'WORKFLOW_IR_ERROR_REASONS',
      'WORKFLOW_IR_EXECUTION_CLASSES',
      'WORKFLOW_IR_PLACEMENT_IDS',
      'WORKFLOW_IR_SCHEMA_VERSION',
      'WORKFLOW_IR_VALUE_TYPE_TAGS',
      'WorkflowIRError',
      'canonicalJsonString',
      'computeWorkflowIRDigest',
      'deserializeWorkflowIR',
      'negotiateWorkflowIRSchemaVersion',
      'serializeWorkflowIR',
      'validateWorkflowIR',
      'workflowIRsAreSemanticallyEqual',
    ]);
  });

  it('the domain exposes no engine, repository, authorization or runtime lifecycle function', () => {
    // WorkflowIR is the semantic source of truth, NOT an execution engine,
    // NOT a repository, NOT a capability/authorization authority and NOT a
    // compiler/teacher. None of those lifecycle verbs may appear on the API.
    const forbiddenLifecycleVerbs =
      /^(execute|run|pause|resume|cancel|deploy|compile|teach|persist|save|load|store|fetch|register|advertise|match|resolve|authorize|grant|fork|install|publish)\w*$/i;
    const functionExports = Object.entries(workflowIr).filter(
      ([, value]) => typeof value === 'function',
    );
    expect(functionExports.length).toBeGreaterThan(0);
    for (const [name] of functionExports) {
      expect(
        forbiddenLifecycleVerbs.test(name),
        `WorkflowIR must not expose lifecycle function "${name}"`,
      ).toBe(false);
    }
  });

  it('the domain contains no database/SQL/persistence semantics (V2-002 surface)', () => {
    const files = walk(DOMAIN_DIR);
    expect(files.length).toBeGreaterThan(0);
    const forbidden: Array<[RegExp, string]> = [
      [/CREATE\s+TABLE/i, 'SQL DDL'],
      [/INSERT\s+INTO/i, 'SQL DML'],
      [/\bSELECT\b/i, 'SQL query'],
      [/wfos_/i, 'WorkflowOS persistence table'],
      [/pglite/i, 'embedded database'],
      [/ioredis/i, 'redis client'],
      [/\bfastify\b/i, 'HTTP server layer'],
      [/\bredis\b/i, 'redis'],
      [/migration/i, 'schema migration'],
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // strip comments so doc mentions don't false-positive
      const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/g, '');
      for (const [pattern, label] of forbidden) {
        expect(
          pattern.test(codeOnly),
          `${relative(BACKEND_ROOT, file)} contains ${label} (${pattern}) — repository persistence is V2-002's surface`,
        ).toBe(false);
      }
    }
  });

  it('the domain contains no capability-advertisement or placement-resolution semantics (V2-004 surface)', () => {
    const files = walk(DOMAIN_DIR);
    const forbidden: Array<[RegExp, string]> = [
      [/nodeAdvertisement|advertiseCapability|capabilityMatch|matchCapabilit/i, 'capability advertisement/matching'],
      [/resolvePlacement|placementDecision|isEligible|eligibilityCheck/i, 'placement resolution / eligibility'],
      [/nodeRegistr|registerNode|nodeTrust|nodeHealth/i, 'node registration/trust/health'],
      [/authorizeExecution|executionAuthoriz/i, 'execution authorization'],
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/g, '');
      for (const [pattern, label] of forbidden) {
        expect(
          pattern.test(codeOnly),
          `${relative(BACKEND_ROOT, file)} contains ${label} (${pattern}) — Node/Capability/placement is V2-004's surface`,
        ).toBe(false);
      }
    }
  });

  describe('capability-requirements set discrimination (both disagreement directions)', () => {
    it('rejects an authored capability set MISSING a step-derived capability', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        (m.requirements as Record<string, unknown>).capabilities = [
          'browser.upload',
          'filesystem.write',
          'messaging.send',
          // spreadsheet.read is derived from read_crm_export but missing here
        ];
      });
      expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_FIELD');
    });

    it('rejects a non-canonical alias inside the authored capability set', () => {
      const doc = rawMut(realWeeklyReportIr(), (m) => {
        (m.requirements as Record<string, unknown>).capabilities = [
          'browser.upload',
          'filesystem.write',
          'messaging.send',
          'messages.send', // non-canonical alias of messaging.send
        ];
      });
      const err = expectWorkflowIRError(() => validateWorkflowIR(doc), 'CAPABILITY_ALIAS');
      expect(err.message).toContain('messaging.send');
    });
  });

  it('decision input ports are subject to exactly-once binding like every data port', () => {
    const doc = rawMut(realWeeklyReportIr(), (m) => {
      m.dataBindings = (m.dataBindings as Array<Record<string, unknown>>).filter(
        (b) => !((b.target as Record<string, unknown>).port === 'urgency'),
      );
    });
    expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNBOUND_INPUT');
  });

  it('the canonical IR is reusable as an input to itself (fixed point, no re-authoring needed)', () => {
    const first = validateWorkflowIR(realWeeklyReportIr());
    const second = validateWorkflowIR(first);
    expect(workflowIr.serializeWorkflowIR(second)).toBe(workflowIr.serializeWorkflowIR(first));
    expect(workflowIr.computeWorkflowIRDigest(second)).toBe(workflowIr.computeWorkflowIRDigest(first));
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

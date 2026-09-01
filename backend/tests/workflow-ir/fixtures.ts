import { expect } from 'vitest';
import type {
  DeepMutableWorkflowIR,
  WorkflowIR,
  WorkflowIRError,
  WorkflowIRErrorReason,
} from '../../src/workflow-ir/index.js';

/**
 * V2-003 — WorkflowIR test fixtures.
 *
 * Shared deterministic fixtures for the WorkflowIR regression battery:
 * - `minimalIr()` — the smallest structurally valid WorkflowIR;
 * - `realWeeklyReportIr()` — a REAL authored workflow (the dogfooding
 *   experiment subject, deliberately authored in NON-canonical order so the
 *   canonicalization/round-trip tests exercise ordering normalization);
 * - error/mutation helpers used by every suite.
 *
 * Everything here is deterministic: no clock, no randomness, no unordered
 * iteration. Two runs of the same fixture produce byte-identical IR.
 */

/** Minimal valid IR: start → one deterministic step → end. */
export function minimalIr(): WorkflowIR {
  return {
    schemaVersion: 1,
    nodes: [
      { kind: 'start', id: 'start' },
      {
        kind: 'step',
        id: 'do_work',
        instruction: 'Perform the unit of work.',
        executionClass: 'deterministic_api',
        capability: 'filesystem.read',
        inputs: [],
        outputs: [],
      },
      { kind: 'end', id: 'done' },
    ],
    edges: [
      { from: 'start', to: 'do_work', kind: 'on_success' },
      { from: 'do_work', to: 'done', kind: 'on_success' },
    ],
    dataBindings: [],
    inputs: [],
    outputs: [],
    dependencies: [],
    requirements: {
      capabilities: ['filesystem.read'],
      placement: { locality: 'any_supported_node' },
    },
    provenance: { origin: 'authored' },
  };
}

/**
 * The REAL authored workflow used by the V2-003 dogfooding experiment
 * ("weekly customer-report packaging"). It exercises every semantic region
 * the IR schema owns:
 *
 * - all four execution classes (deterministic_api ×3, agentic_computer_use,
 *   human approval, subworkflow);
 * - control semantics: on_success, on_failure, on_approval, on_rejection,
 *   on_case, on_default, decision cases, failure retry;
 * - data semantics: string / object_ref / secret_ref / json / list<string>
 *   typed ports, workflow inputs/outputs, literals, fan-out;
 * - failure ends (outcome: 'failure') and pause-safe steps;
 * - opaque secret reference (api_token) — never secret material;
 * - provenance and an explicit subworkflow dependency.
 *
 * Authored deliberately NON-canonically (shuffled arrays, unsorted derived
 * capability set) so canonicalization is observable.
 */
export function realWeeklyReportIr(): WorkflowIR {
  return {
    schemaVersion: 1,
    nodes: [
      { kind: 'end', id: 'failed', outcome: 'failure' },
      {
        kind: 'step',
        id: 'read_crm_export',
        instruction: 'Read the weekly CRM engagement export for the reporting window.',
        executionClass: 'deterministic_api',
        capability: 'spreadsheet.read',
        inputs: [
          { id: 'week', type: 'string' },
          { id: 'source', type: 'object_ref' },
        ],
        outputs: [{ id: 'engagements', type: 'json' }],
        pauseSafe: true,
        failure: { retry: 1 },
      },
      { kind: 'start', id: 'start' },
      {
        kind: 'step',
        id: 'draft_summary',
        instruction: 'Draft the weekly summary from the engagement rows.',
        executionClass: 'agentic_computer_use',
        capability: 'filesystem.write',
        inputs: [{ id: 'rows', type: 'json' }],
        outputs: [
          { id: 'report_doc', type: 'object_ref' },
          { id: 'summary_text', type: 'string' },
        ],
        failure: { retry: 1 },
      },
      {
        kind: 'step',
        id: 'approve_release',
        instruction: 'Review the draft summary and approve it for distribution.',
        executionClass: 'human',
        inputs: [{ id: 'draft', type: 'string' }],
        outputs: [],
        requestApproval: true,
        pauseSafe: true,
      },
      {
        kind: 'decision',
        id: 'recipient_check',
        inputs: [{ id: 'urgency', type: 'string' }],
        cases: [{ id: 'urgent', condition: { kind: 'equals', value: 'urgent' } }],
      },
      {
        kind: 'step',
        id: 'upload_report',
        instruction: 'Upload the approved report document to the customer portal.',
        executionClass: 'deterministic_api',
        capability: 'browser.upload',
        inputs: [
          { id: 'report', type: 'object_ref' },
          { id: 'token', type: 'secret_ref' },
        ],
        outputs: [],
      },
      {
        kind: 'step',
        id: 'notify_team',
        instruction: 'Send the summary message to the recipient list.',
        executionClass: 'deterministic_api',
        capability: 'messaging.send',
        inputs: [
          { id: 'recipients', type: { list: 'string' } },
          { id: 'message', type: 'string' },
        ],
        outputs: [],
      },
      {
        kind: 'step',
        id: 'archive_run',
        instruction: 'Archive the uploaded report through the archival subworkflow.',
        executionClass: 'subworkflow',
        dependency: 'archive_subworkflow',
        inputs: [{ id: 'report', type: 'object_ref' }],
        outputs: [],
      },
      { kind: 'end', id: 'done' },
    ],
    edges: [
      { from: 'start', to: 'read_crm_export', kind: 'on_success' },
      { from: 'read_crm_export', to: 'draft_summary', kind: 'on_success' },
      { from: 'draft_summary', to: 'approve_release', kind: 'on_success' },
      { from: 'draft_summary', to: 'failed', kind: 'on_failure' },
      { from: 'approve_release', to: 'recipient_check', kind: 'on_approval' },
      { from: 'approve_release', to: 'failed', kind: 'on_rejection' },
      { from: 'recipient_check', to: 'notify_team', kind: 'on_case', case: 'urgent' },
      { from: 'recipient_check', to: 'upload_report', kind: 'on_default' },
      { from: 'upload_report', to: 'notify_team', kind: 'on_success' },
      { from: 'notify_team', to: 'archive_run', kind: 'on_success' },
      { from: 'archive_run', to: 'done', kind: 'on_success' },
    ],
    dataBindings: [
      {
        source: { kind: 'workflow_input', input: 'report_week' },
        target: { kind: 'node_input', node: 'read_crm_export', port: 'week' },
      },
      {
        source: { kind: 'workflow_input', input: 'crm_export' },
        target: { kind: 'node_input', node: 'read_crm_export', port: 'source' },
      },
      {
        source: { kind: 'node_output', node: 'read_crm_export', port: 'engagements' },
        target: { kind: 'node_input', node: 'draft_summary', port: 'rows' },
      },
      {
        source: { kind: 'node_output', node: 'draft_summary', port: 'summary_text' },
        target: { kind: 'node_input', node: 'approve_release', port: 'draft' },
      },
      {
        source: { kind: 'workflow_input', input: 'urgency' },
        target: { kind: 'node_input', node: 'recipient_check', port: 'urgency' },
      },
      {
        source: { kind: 'node_output', node: 'draft_summary', port: 'report_doc' },
        target: { kind: 'node_input', node: 'upload_report', port: 'report' },
      },
      {
        source: { kind: 'workflow_input', input: 'api_token' },
        target: { kind: 'node_input', node: 'upload_report', port: 'token' },
      },
      {
        source: { kind: 'workflow_input', input: 'recipients' },
        target: { kind: 'node_input', node: 'notify_team', port: 'recipients' },
      },
      {
        source: { kind: 'node_output', node: 'draft_summary', port: 'summary_text' },
        target: { kind: 'node_input', node: 'notify_team', port: 'message' },
      },
      {
        source: { kind: 'node_output', node: 'draft_summary', port: 'report_doc' },
        target: { kind: 'node_input', node: 'archive_run', port: 'report' },
      },
      {
        source: { kind: 'node_output', node: 'draft_summary', port: 'report_doc' },
        target: { kind: 'workflow_output', output: 'final_report' },
      },
    ],
    inputs: [
      { id: 'report_week', type: 'string' },
      { id: 'crm_export', type: 'object_ref' },
      { id: 'api_token', type: 'secret_ref' },
      { id: 'recipients', type: { list: 'string' } },
      { id: 'urgency', type: 'string' },
    ],
    outputs: [{ id: 'final_report', type: 'object_ref' }],
    dependencies: [{ id: 'archive_subworkflow', workflowVersionId: 'wf-archival@v3' }],
    requirements: {
      // deliberately unsorted — canonical form derives + sorts this set
      capabilities: [
        'messaging.send',
        'browser.upload',
        'spreadsheet.read',
        'filesystem.write',
      ],
      placement: { locality: 'device_preferred', disallowed: ['cloud_required'] },
    },
    provenance: {
      origin: 'authored',
      generator: 'workflowos-authoring-fixture/1',
      sourceReferences: ['brief-w35', 'brief-w34'],
    },
  };
}

/**
 * The minimal IR serialized to non-canonical presentation (pretty-printed,
 * key order shuffled, arrays reversed) — the same semantics.
 */
export function minimalIrNonCanonicalText(): string {
  return [
    '{',
    '  "provenance": { "origin": "authored" },',
    '  "schemaVersion": 1,',
    '  "requirements": {',
    '    "placement": { "locality": "any_supported_node", "disallowed": [] },',
    '    "capabilities": ["filesystem.read"]',
    '  },',
    '  "outputs": [],',
    '  "inputs": [],',
    '  "dependencies": [],',
    '  "dataBindings": [],',
    '  "nodes": [',
    '    { "kind": "end", "id": "done" },',
    '    { "id": "start", "kind": "start" },',
    '    { "outputs": [], "inputs": [], "kind": "step", "instruction": "Perform the unit of work.",',
    '      "executionClass": "deterministic_api", "id": "do_work", "capability": "filesystem.read" }',
    '  ],',
    '  "edges": [',
    '    { "kind": "on_success", "from": "do_work", "to": "done" },',
    '    { "from": "start", "to": "do_work", "kind": "on_success" }',
    '  ]',
    '}',
  ].join('\n');
}

/** The exact canonical serialization of `minimalIr()` (golden determinism anchor). */
export const MINIMAL_IR_CANONICAL_TEXT: string =
  '{"dataBindings":[],"dependencies":[],"edges":[{"from":"do_work","kind":"on_success","to":"done"},{"from":"start","kind":"on_success","to":"do_work"}],"inputs":[],"nodes":[{"capability":"filesystem.read","executionClass":"deterministic_api","id":"do_work","inputs":[],"instruction":"Perform the unit of work.","kind":"step","outputs":[]},{"id":"done","kind":"end"},{"id":"start","kind":"start"}],"outputs":[],"provenance":{"origin":"authored"},"requirements":{"capabilities":["filesystem.read"],"placement":{"locality":"any_supported_node"}},"schemaVersion":1}';

/** Deterministically mutate a copy of a document (typed, deep-mutable). */
export function mut(doc: WorkflowIR, edit: (m: DeepMutableWorkflowIR) => void): WorkflowIR {
  const copy: DeepMutableWorkflowIR = structuredClone(doc);
  edit(copy);
  return copy as WorkflowIR;
}

/** Assert that `fn` throws a WorkflowIRError with exactly `reason`. */
export function expectWorkflowIRError(
  fn: () => unknown,
  reason: WorkflowIRErrorReason,
  label?: string,
): WorkflowIRError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  const context = label ? ` (${label})` : '';
  expect(thrown, `expected WorkflowIRError ${reason}${context}, got no error`).toBeDefined();
  expect(
    thrown,
    `expected WorkflowIRError ${reason}${context}, got: ${String(thrown)}`,
  ).toBeInstanceOf(Error);
  const err = thrown as WorkflowIRError;
  expect(err.name).toBe('WorkflowIRError');
  expect(
    err.reason,
    `expected reason ${reason}${context}, got: ${String(err.message)}`,
  ).toBe(reason);
  return err;
}

/** A fake secret value that must NEVER appear in any serialized WorkflowIR. */
export const FAKE_SECRET_MATERIAL = 'ghp_live_secret_0123456789abcdef';

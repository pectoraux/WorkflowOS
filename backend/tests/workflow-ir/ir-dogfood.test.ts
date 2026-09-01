import { describe, it, expect } from 'vitest';
import {
  validateWorkflowIR,
  serializeWorkflowIR,
  deserializeWorkflowIR,
  computeWorkflowIRDigest,
  workflowIRsAreSemanticallyEqual,
} from '../../src/workflow-ir/index.js';
import { realWeeklyReportIr } from './fixtures.js';

/**
 * V2-003 — REAL workflow IR round-trip dogfooding experiment (executable half).
 *
 * Dogfooding protocol (spec/architecture/v2/dogfooding-protocol.md, V2-003
 * row): "Author a real workflow, serialize to IR, deserialize, and
 * execute/inspect it for semantic equivalence."
 *
 * This suite performs the experiment through the real product path:
 * - AUTHOR the real "weekly customer-report packaging" workflow (a workflow a
 *   person actually wants: CRM export → draft → human approval →
 *   urgent/standard routing → portal upload → team notification → archival
 *   subworkflow);
 * - SERIALIZE it to canonical WorkflowIR bytes;
 * - DESERIALIZE it back through the strict parser;
 * - INSPECT it node-by-node, edge-by-edge and binding-by-binding for semantic
 *   equivalence against the authored intent (user-visible meaning = every
 *   instruction and construct; executable meaning = control/data semantics,
 *   capability requirements, placement and failure policy).
 *
 * Execution is owned by V2-005/V2-008 (not merged in W1), so "execute" is
 * honestly represented by the inspection half the protocol wording allows;
 * no mock executor is introduced (that would be a second engine).
 *
 * The human-observed result is recorded in
 * spec/architecture/v2/dogfooding-evidence/V2-003-dogfooding.md.
 */
describe('V2-003 dogfooding: real workflow IR round-trip', () => {
  const authored = realWeeklyReportIr();
  const canonicalBytes = serializeWorkflowIR(authored);
  const roundTripped = deserializeWorkflowIR(canonicalBytes);

  it('step 1 — the authored real workflow is valid WorkflowIR', () => {
    const ir = validateWorkflowIR(authored);
    expect(ir.nodes).toHaveLength(10);
    expect(ir.inputs.map((i) => i.id).sort()).toEqual([
      'api_token',
      'crm_export',
      'recipients',
      'report_week',
      'urgency',
    ]);
  });

  it('step 2 — serialization is deterministic canonical bytes', () => {
    expect(canonicalBytes).toBe(serializeWorkflowIR(realWeeklyReportIr()));
    expect(canonicalBytes).not.toMatch(/\s/);
  });

  it('step 3 — deserialization reconstructs the identical semantics', () => {
    expect(workflowIRsAreSemanticallyEqual(roundTripped, authored)).toBe(true);
    expect(serializeWorkflowIR(roundTripped)).toBe(canonicalBytes);
  });

  it('inspection — user-visible meaning is unchanged (every instruction survives byte-identically)', () => {
    const expectedInstructions: Record<string, string> = {
      read_crm_export: 'Read the weekly CRM engagement export for the reporting window.',
      draft_summary: 'Draft the weekly summary from the engagement rows.',
      approve_release: 'Review the draft summary and approve it for distribution.',
      upload_report: 'Upload the approved report document to the customer portal.',
      notify_team: 'Send the summary message to the recipient list.',
      archive_run: 'Archive the uploaded report through the archival subworkflow.',
    };
    for (const [id, instruction] of Object.entries(expectedInstructions)) {
      const node = roundTripped.nodes.find((n) => n.id === id);
      expect(node, `node ${id} survived the round trip`).toBeDefined();
      expect(node && node.kind === 'step' ? node.instruction : '').toBe(instruction);
    }
  });

  it('inspection — every construct survives with its semantics', () => {
    const node = (id: string) => roundTripped.nodes.find((n) => n.id === id)!;

    // all four execution classes survive
    expect(node('read_crm_export').kind === 'step' && node('read_crm_export').executionClass).toBe('deterministic_api');
    expect(node('draft_summary').kind === 'step' && node('draft_summary').executionClass).toBe('agentic_computer_use');
    expect(node('approve_release').kind === 'step' && node('approve_release').executionClass).toBe('human');
    expect(node('archive_run').kind === 'step' && node('archive_run').executionClass).toBe('subworkflow');

    // human approval construct survives
    expect(node('approve_release').kind === 'step' && node('approve_release').requestApproval).toBe(true);

    // pause-safe construct survives
    expect(node('read_crm_export').kind === 'step' && node('read_crm_export').pauseSafe).toBe(true);
    expect(node('approve_release').kind === 'step' && node('approve_release').pauseSafe).toBe(true);

    // failure policy survives
    expect(node('draft_summary').kind === 'step' && node('draft_summary').failure).toEqual({ retry: 1 });
    expect(node('read_crm_export').kind === 'step' && node('read_crm_export').failure).toEqual({ retry: 1 });

    // decision + default + case survive
    const decision = node('recipient_check');
    expect(decision.kind).toBe('decision');
    if (decision.kind === 'decision') {
      expect(decision.cases).toEqual([
        { id: 'urgent', condition: { kind: 'equals', value: 'urgent' } },
      ]);
    }

    // subworkflow dependency survives opaquely
    expect(node('archive_run').kind === 'step' && node('archive_run').dependency).toBe('archive_subworkflow');
    expect(roundTripped.dependencies).toEqual([
      { id: 'archive_subworkflow', workflowVersionId: 'wf-archival@v3' },
    ]);

    // end outcomes survive
    expect(node('failed').kind === 'end' && node('failed').outcome).toBe('failure');
    expect(node('done').kind === 'end' && 'outcome' in node('done')).toBe(false);
  });

  it('inspection — executable meaning is unchanged (control semantics)', () => {
    const expectedEdges = new Set(
      realWeeklyReportIr().edges.map((e) =>
        [e.from, e.kind, e.case ?? '', e.to].join('|'),
      ),
    );
    const observedEdges = new Set(
      roundTripped.edges.map((e) => [e.from, e.kind, e.case ?? '', e.to].join('|')),
    );
    expect(observedEdges).toEqual(expectedEdges);
    // the approval gate is load-bearing: approve_release has no on_success
    expect(
      roundTripped.edges.filter((e) => e.from === 'approve_release').map((e) => e.kind).sort(),
    ).toEqual(['on_approval', 'on_rejection']);
    // the decision is deterministic: every case + exactly one default
    expect(
      roundTripped.edges.filter((e) => e.from === 'recipient_check').map((e) => e.kind).sort(),
    ).toEqual(['on_case', 'on_default']);
  });

  it('inspection — executable meaning is unchanged (data semantics)', () => {
    const expectedBindings = new Set(
      realWeeklyReportIr().dataBindings.map((b) => {
        const source =
          b.source.kind === 'workflow_input'
            ? `input:${b.source.input}`
            : b.source.kind === 'node_output'
              ? `out:${b.source.node}.${b.source.port}`
              : `literal:${JSON.stringify(b.source.literal)}`;
        const target =
          b.target.kind === 'node_input'
            ? `in:${b.target.node}.${b.target.port}`
            : `output:${b.target.output}`;
        return `${source}->${target}`;
      }),
    );
    const observedBindings = new Set(
      roundTripped.dataBindings.map((b) => {
        const source =
          b.source.kind === 'workflow_input'
            ? `input:${b.source.input}`
            : b.source.kind === 'node_output'
              ? `out:${b.source.node}.${b.source.port}`
              : `literal:${JSON.stringify(b.source.literal)}`;
        const target =
          b.target.kind === 'node_input'
            ? `in:${b.target.node}.${b.target.port}`
            : `output:${b.target.output}`;
        return `${source}->${target}`;
      }),
    );
    expect(observedBindings).toEqual(expectedBindings);

    // typed interface survives
    expect(roundTripped.inputs.find((i) => i.id === 'recipients')?.type).toEqual({
      list: 'string',
    });
    expect(roundTripped.inputs.find((i) => i.id === 'api_token')?.type).toBe('secret_ref');
    expect(roundTripped.outputs).toEqual([{ id: 'final_report', type: 'object_ref' }]);
  });

  it('inspection — requirements and provenance are unchanged', () => {
    expect(roundTripped.requirements.capabilities).toEqual([
      'browser.upload',
      'filesystem.write',
      'messaging.send',
      'spreadsheet.read',
    ]);
    expect(roundTripped.requirements.placement).toEqual({
      locality: 'device_preferred',
      disallowed: ['cloud_required'],
    });
    expect(roundTripped.provenance.origin).toBe('authored');
    expect(roundTripped.provenance.generator).toBe('workflowos-authoring-fixture/1');
    expect(roundTripped.provenance.sourceReferences).toEqual(['brief-w34', 'brief-w35']);
  });

  it('inspection — the secret stays an opaque reference through the whole path', () => {
    expect(canonicalBytes).not.toContain('ghp_');
    expect(canonicalBytes).toContain('"secret_ref"');
  });

  it('inspection — semantic identity is stable (digest)', () => {
    const digest = computeWorkflowIRDigest(authored);
    expect(computeWorkflowIRDigest(roundTripped)).toBe(digest);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // repeat experiment converges byte-identically
    const again = deserializeWorkflowIR(serializeWorkflowIR(realWeeklyReportIr()));
    expect(computeWorkflowIRDigest(again)).toBe(digest);
  });

  it('a second authoring pass with different presentation converges (cross-client)', () => {
    const secondPass = structuredClone(realWeeklyReportIr());
    secondPass.nodes = [...secondPass.nodes].reverse();
    secondPass.edges = [...secondPass.edges].reverse();
    secondPass.dataBindings = [...secondPass.dataBindings].reverse();
    expect(computeWorkflowIRDigest(secondPass)).toBe(computeWorkflowIRDigest(authored));
  });
});

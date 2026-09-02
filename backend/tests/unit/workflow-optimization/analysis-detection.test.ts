import { describe, it, expect } from 'vitest';
import {
  authorCleanSubstitutableDocument,
  authorSensitiveSubstitutableDocument,
  authorUiAutomationDocument,
  authorReuseDocument,
  authorTwoSubstitutableNodesDocument,
  composeOptimizationService,
} from './helpers.js';
import { OPTIMIZATION_RULES_VERSION } from '../../../src/workflow-optimization/index.js';
/**
 * V2-011 — opportunity detection (the analysis layer).
 *
 * The analysis is a PURE deterministic function over one WorkflowIrDocument:
 * API substitution opportunities (agentic nodes whose declared requirements
 * are all served by stable ordinary APIs), reuse opportunities (duplicated
 * non-human logic), and NO opportunities for pure-UI agentic nodes (the
 * agentic class is the required mechanism there).
 */
describe('V2-011 — api_substitution detection', () => {
  it('detects the agentic node whose requirements are all API-stable ordinary capabilities', () => {
    const { service } = composeOptimizationService();
    const analysis = service.analyzeWorkflow(authorCleanSubstitutableDocument());

    expect(analysis.opportunities).toHaveLength(1);
    const opportunity = analysis.opportunities[0]!;
    expect(opportunity.kind).toBe('api_substitution');
    if (opportunity.kind === 'api_substitution') {
      expect(opportunity.nodeId).toBe('scan_board');
      expect(opportunity.declaredTask).toBe('Scan the repository board and summarize the open ticket digest.');
      expect(opportunity.declaredRequirements).toEqual(['github.repository.read']);
      expect(opportunity.apiCapability).toBe('github.repository.read');
      // the rationale interpolates ONLY declared facts
      expect(opportunity.rationale).toContain('scan_board');
      expect(opportunity.rationale).toContain('github.repository.read');
      expect(opportunity.rationale).toContain('agentic_computer_use');
    }
    expect(analysis.rejected).toEqual([]);
    expect(analysis.rulesVersion).toBe(OPTIMIZATION_RULES_VERSION);
  });

  it('detects BOTH substitutable agentic nodes in the two-node fixture', () => {
    const { service } = composeOptimizationService();
    const analysis = service.analyzeWorkflow(authorTwoSubstitutableNodesDocument());
    const apiOpportunities = analysis.opportunities.filter((o) => o.kind === 'api_substitution');
    expect(apiOpportunities.map((o) => (o.kind === 'api_substitution' ? o.nodeId : ''))).toEqual([
      'scan_a',
      'scan_b',
    ]);
  });

  it('a pure-UI agentic node (browser capabilities) yields NO opportunity and NO rejection', () => {
    const { service } = composeOptimizationService();
    const analysis = service.analyzeWorkflow(authorUiAutomationDocument());
    expect(analysis.opportunities).toEqual([]);
    expect(analysis.rejected).toEqual([]);
  });

  it('an agentic node with NO requirements yields no opportunity', () => {
    const { service } = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();
    const stripped = {
      ...document,
      ir: {
        ...document.ir,
        nodes: document.ir.nodes.map((node) =>
          node.id === 'scan_board' ? { ...node, capabilityRequirements: [] } : node,
        ),
      },
    };
    const analysis = service.analyzeWorkflow(stripped);
    expect(analysis.opportunities).toEqual([]);
  });
});

describe('V2-011 — workflow_reuse detection', () => {
  it('detects the duplicated node group with the canonical first site preserved', () => {
    const { service } = composeOptimizationService();
    const analysis = service.analyzeWorkflow(authorReuseDocument());

    expect(analysis.opportunities).toHaveLength(1);
    const opportunity = analysis.opportunities[0]!;
    expect(opportunity.kind).toBe('workflow_reuse');
    if (opportunity.kind === 'workflow_reuse') {
      expect(opportunity.nodeIds).toEqual(['normalize_a', 'normalize_b']);
      expect(opportunity.substitutionSiteNodeIds).toEqual(['normalize_b']);
      expect(opportunity.rationale).toContain('normalize_a');
      expect(opportunity.rationale).toContain('normalize_b');
    }
    expect(analysis.rejected).toEqual([]);
  });

  it('documents with no duplicated logic yield no reuse opportunity', () => {
    const { service } = composeOptimizationService();
    const analysis = service.analyzeWorkflow(authorCleanSubstitutableDocument());
    expect(analysis.opportunities.filter((o) => o.kind === 'workflow_reuse')).toEqual([]);
  });
});

describe('V2-011 — analysis determinism and immutability', () => {
  it('the same document always yields the identical analysis (id, opportunities, rejections)', () => {
    const { service } = composeOptimizationService();
    const document = authorCleanSubstitutableDocument();
    const first = service.analyzeWorkflow(document);
    const second = service.analyzeWorkflow(document);
    expect(second).toEqual(first);
    expect(second.analysisId).toBe(first.analysisId);
  });

  it('the analysis identity differs between different documents', () => {
    const { service } = composeOptimizationService();
    const clean = service.analyzeWorkflow(authorCleanSubstitutableDocument());
    const reuse = service.analyzeWorkflow(authorReuseDocument());
    expect(clean.analysisId).not.toBe(reuse.analysisId);
  });

  it('the embedded document is deep-frozen (analysis never mutates its input)', () => {
    const { service } = composeOptimizationService();
    const analysis = service.analyzeWorkflow(authorCleanSubstitutableDocument());
    expect(() => {
      (analysis as unknown as { document: { ir: { start: string } } }).document.ir.start = 'mutated';
    }).toThrow();
    expect(() => {
      (analysis as unknown as { opportunities: { nodeId: string }[] }).opportunities[0]!.nodeId =
        'mutated';
    }).toThrow();
  });

  it('a different valid document yields a different analysisId', () => {
    const { service } = composeOptimizationService();
    const base = service.analyzeWorkflow(authorCleanSubstitutableDocument());
    const sensitive = service.analyzeWorkflow(authorSensitiveSubstitutableDocument());
    expect(sensitive.analysisId).not.toBe(base.analysisId);
  });
});

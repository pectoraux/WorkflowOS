/**
 * V2-011 — the candidate derivation.
 *
 * Both substitution kinds derive a NEW WorkflowIrDocument from the
 * baseline: the affected node keeps its id, port bindings, port
 * declarations, failure policy, placement and completion evidence
 * VERBATIM (the task surface — see comparison.ts); ONLY the execution
 * mechanism changes:
 *
 *   - api_substitution: the agentic_computer_use spec becomes the
 *     deterministic_api spec carrying the primary API-stable ordinary
 *     requirement; the requirements become exactly that capability;
 *   - workflow_reuse: each duplicate site's spec becomes an OPAQUE
 *     subworkflow reference to the owner-supplied existing workflow
 *     version (V2-003: opaque identifiers — repository semantics own
 *     what they resolve to); the requirements become workflow.execute.
 *
 * The derived candidate honestly declares compatibility 'equivalent'
 * with unchanged input/output surfaces — cross-checked by the MERGED
 * V2-003 negotiation (never re-derived here). The baseline document is
 * NEVER mutated: derivation deep-clones first.
 */
import type { WorkflowIrDocument, SubworkflowDependency } from '../../workflow-ir/index.js';
import type { SubworkflowReuseTarget } from '../types.js';

/** The honest compatibility declaration for a task-surface-preserving candidate. */
const EQUIVALENT_COMPATIBILITY = {
  compatibilityLevel: 'equivalent',
  inputSurfaceChange: 'none',
  outputSurfaceChange: 'none',
} as const;

function cloneDocument(document: WorkflowIrDocument): WorkflowIrDocument {
  return JSON.parse(JSON.stringify(document)) as WorkflowIrDocument;
}

/** Derive the api_substitution candidate (one agentic node → deterministic API). */
export function deriveApiSubstitutionCandidate(
  baseline: WorkflowIrDocument,
  nodeId: string,
): WorkflowIrDocument {
  const cloned = cloneDocument(baseline);
  return {
    ...cloned,
    compatibility: EQUIVALENT_COMPATIBILITY,
    ir: {
      ...cloned.ir,
      nodes: cloned.ir.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }
        const apiCapability = node.capabilityRequirements[0]!;
        return {
          ...node,
          executionClass: 'deterministic_api' as const,
          spec: { class: 'deterministic_api' as const, capability: apiCapability },
          capabilityRequirements: [apiCapability],
        };
      }),
    },
  };
}

/** Derive the workflow_reuse candidate (duplicate sites → opaque subworkflow references). */
export function deriveReuseSubstitutionCandidate(
  baseline: WorkflowIrDocument,
  substitutionSiteNodeIds: readonly string[],
  target: SubworkflowReuseTarget,
): WorkflowIrDocument {
  const cloned = cloneDocument(baseline);
  const sites = new Set<string>(substitutionSiteNodeIds);
  const dependency: SubworkflowDependency = {
    workflowId: target.workflowId,
    versionRef: target.versionRef,
  };
  return {
    ...cloned,
    compatibility: EQUIVALENT_COMPATIBILITY,
    ir: {
      ...cloned.ir,
      nodes: cloned.ir.nodes.map((node) => {
        if (!sites.has(node.id)) {
          return node;
        }
        return {
          ...node,
          executionClass: 'subworkflow' as const,
          spec: { class: 'subworkflow' as const, subworkflow: dependency },
          capabilityRequirements: ['workflow.execute' as const],
        };
      }),
    },
  };
}

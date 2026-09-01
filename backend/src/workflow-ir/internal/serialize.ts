import { createHash } from 'node:crypto';
import { fail } from './errors.js';
import { canonicalJsonString } from './canonical-json.js';
import { parseStrictJson } from './strict-json.js';
import { validateWorkflowIR } from './validate.js';
import type { WorkflowIR, WorkflowIRValidationOptions } from '../types.js';

/**
 * V2-003 — deterministic serialization, semantic digest and version
 * negotiation for WorkflowIR.
 *
 * Registry rule (V2-CTRL-003 "Canonical identity and digest rules"):
 *   SHA-256(canonical-json(semantic-object))
 * Presentation formatting, transport envelopes, repository metadata,
 * marketplace pricing, UX state and deployment placement are excluded from
 * the semantic value.
 */

/**
 * Serialize a WorkflowIR document to its canonical bytes: the deterministic
 * presentation of the semantic object (sorted keys, no whitespace, declared
 * sets sorted/de-duplicated, schema defaults omitted). Validation runs first
 * — an invalid document is never serialized.
 */
export function serializeWorkflowIR(doc: unknown): string {
  return canonicalJsonString(validateWorkflowIR(doc));
}

/**
 * Deserialize canonical (or non-canonical but equivalent) WorkflowIR text.
 * Parsing is strict: invalid JSON, duplicate object keys and trailing content
 * fail closed with PARSE_ERROR. The result is the deeply frozen canonical
 * form.
 */
export function deserializeWorkflowIR(
  text: string,
  options?: WorkflowIRValidationOptions,
): WorkflowIR {
  if (typeof text !== 'string') {
    fail('PARSE_ERROR', `WorkflowIR text must be a string, got ${typeof text}`);
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text);
  } catch (error) {
    fail('PARSE_ERROR', error instanceof Error ? error.message : String(error));
  }
  return validateWorkflowIR(parsed, options);
}

/**
 * The WorkflowVersion semantic digest: SHA-256 over the canonical
 * serialization of the semantic object. Deterministic across repeated
 * computation and across presentation changes; distinct for semantically
 * different workflows. (Distinct from an ExecutionDigest, whose canonical
 * domain is `workflowos/execution-statement/v1`.)
 */
export function computeWorkflowIRDigest(doc: unknown): string {
  const canonicalText = serializeWorkflowIR(doc);
  return createHash('sha256').update(canonicalText, 'utf8').digest('hex');
}

/**
 * Semantic equality: two documents are semantically equal exactly when their
 * canonical forms are byte-identical (equivalently: their semantic digests
 * match). Fails closed — an invalid document throws instead of comparing.
 */
export function workflowIRsAreSemanticallyEqual(a: unknown, b: unknown): boolean {
  return computeWorkflowIRDigest(a) === computeWorkflowIRDigest(b);
}

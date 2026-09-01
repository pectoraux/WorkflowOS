/**
 * V2-003 — WorkflowIR error taxonomy.
 *
 * Validation fails closed: every structurally or semantically invalid
 * WorkflowIR document is rejected with exactly one frozen reason. The
 * vocabulary is pinned by tests/workflow-ir/ir-schema.test.ts; adding or
 * renaming a reason is a deliberate schema change.
 */

/**
 * The frozen error-reason vocabulary (sorted, unique).
 */
export const WORKFLOW_IR_ERROR_REASONS = [
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
] as const;

export type WorkflowIRErrorReason = (typeof WORKFLOW_IR_ERROR_REASONS)[number];

/**
 * The single error type thrown by every WorkflowIR operation. The `reason` is
 * always a member of WORKFLOW_IR_ERROR_REASONS; the message always starts with
 * `REASON: detail`.
 */
export class WorkflowIRError extends Error {
  readonly reason: WorkflowIRErrorReason;

  constructor(reason: WorkflowIRErrorReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'WorkflowIRError';
    this.reason = reason;
  }
}

/** Fail closed with a frozen reason. */
export function fail(reason: WorkflowIRErrorReason, detail: string): never {
  throw new WorkflowIRError(reason, detail);
}

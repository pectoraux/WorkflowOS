/**
 * V2-002 — typed repository errors.
 *
 * The service throws exactly these typed errors; the HTTP route layer maps
 * the stable `code` to a status. Unknown failures propagate (fail closed —
 * never silently swallowed).
 */

/** Stable error codes mapped 1:1 to HTTP statuses by the route layer. */
export type WorkflowRepositoryErrorCode =
  | 'validation' // 400 — malformed input, invalid enum, non-object content
  | 'forbidden' // 403 — authenticated but not permitted
  | 'not-found' // 404 — missing resource OR no visible access (no existence leak)
  | 'conflict' // 409 — state conflict (archived workflow, disabled installation)
  | 'unsupported-protocol'; // 409 — protocol version outside the supported set

export class WorkflowRepositoryError extends Error {
  readonly code: WorkflowRepositoryErrorCode;

  constructor(code: WorkflowRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowRepositoryError';
    this.code = code;
  }
}

/** Convenience constructors (keep call sites declarative). */
export const validationError = (message: string): WorkflowRepositoryError =>
  new WorkflowRepositoryError('validation', message);
export const forbiddenError = (message: string): WorkflowRepositoryError =>
  new WorkflowRepositoryError('forbidden', message);
export const notFoundError = (message: string): WorkflowRepositoryError =>
  new WorkflowRepositoryError('not-found', message);
export const conflictError = (message: string): WorkflowRepositoryError =>
  new WorkflowRepositoryError('conflict', message);
export const unsupportedProtocolError = (message: string): WorkflowRepositoryError =>
  new WorkflowRepositoryError('unsupported-protocol', message);

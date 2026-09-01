import { createHash } from 'node:crypto';

/**
 * V2-002 — canonical content addressing (registry-governed).
 *
 * Implements the V2-CTRL-003 canonical digest rule:
 *   SHA-256(canonical-json(semantic-object))
 * Canonical JSON = UTF-8 JSON with deterministic (sorted) object-key
 * ordering, preserved array ordering, no insignificant whitespace, and
 * normalized primitive representations. Presentation formatting and
 * repository metadata (name/description/visibility/marketplace/UX state)
 * are NEVER part of the digest — the digest commits to semantic content
 * only.
 *
 * Determinism discipline (V2-002): no wall-clock time, no randomness, no
 * unordered iteration participates in any digest or derived identity.
 * Identical inputs always produce byte-identical outputs.
 */

/** The canonical digest algorithm (V2-CTRL-003 registry: digest.algorithm). */
export const DIGEST_ALGORITHM = 'SHA-256' as const;

/** The WorkflowOS 2.0 protocol version (the only supported version). */
export const V2_PROTOCOL_VERSION = '2.0' as const;

/** Closed set of supported protocol versions (fail closed on others). */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2.0'];

/** Canonical registry visibility identifiers (V2-CTRL-003: visibility). */
export const WORKFLOW_VISIBILITIES: readonly string[] = ['private', 'organization', 'public'];

/** Canonical workflow lifecycle statuses (V2-002-owned vocabulary). */
export const WORKFLOW_LIFECYCLE_STATUSES: readonly string[] = ['active', 'archived'];

/** Canonical per-workflow collaborator roles (V2-002-owned vocabulary). */
export const WORKFLOW_COLLABORATOR_ROLES: readonly string[] = ['owner', 'writer', 'reader'];

/** Canonical installation statuses (V2-002-owned vocabulary). */
export const WORKFLOW_INSTALLATION_STATUSES: readonly string[] = ['enabled', 'disabled'];

const WORKFLOW_VERSION_ID_PREFIX = 'wfv_';

/**
 * Serialize a JSON value to its canonical form: recursively sorted object
 * keys, preserved array order, no insignificant whitespace. Non-JSON values
 * (functions, `undefined`, `symbol`, `bigint`, non-finite numbers) throw —
 * deterministic fail-closed rather than silent coercion.
 */
export function canonicalizeJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalizeJson: non-finite numbers are not JSON');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonicalizeJson: bigint is not JSON');
    case 'symbol':
      throw new TypeError('canonicalizeJson: symbol is not JSON');
    case 'function':
      throw new TypeError('canonicalizeJson: function is not JSON');
    case 'undefined':
      throw new TypeError('canonicalizeJson: undefined is not JSON');
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalizeJson: unsupported value type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => serializeCanonical(item));
    return `[${items.join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  // Deterministic key ordering: sort by UTF-16 code unit (stable and total).
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${serializeCanonical(record[key])}`);
  }
  return `{${parts.join(',')}}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The WorkflowVersion content digest: SHA-256 hex over
 * canonical-json(semantic-object). Repository metadata is excluded (the
 * caller passes ONLY the semantic content document).
 */
export function computeContentDigest(content: unknown): string {
  return sha256Hex(canonicalizeJson(content));
}

/**
 * The authoritative identity inputs of a WorkflowVersion (constitution §2 +
 * V2-CTRL-003 deterministic-ID rule: identity derives only from the owning
 * object contract's authoritative inputs — never from UI session ids,
 * wall-clock time, or random text).
 */
export interface WorkflowVersionIdentityInputs {
  readonly workflowId: string;
  readonly contentDigest: string;
  readonly parentVersionId: string | null;
  readonly protocolVersion: string;
}

/**
 * Derive the WorkflowVersion id deterministically from its authoritative
 * identity inputs. Identical inputs converge on the identical id (duplicate
 * delivery converges); every input is load-bearing (see the V2-002 battery's
 * mutation-discrimination tests).
 */
export function deriveWorkflowVersionId(input: WorkflowVersionIdentityInputs): string {
  const canonical = canonicalizeJson({
    workflowId: input.workflowId,
    contentDigest: input.contentDigest,
    parentVersionId: input.parentVersionId,
    protocolVersion: input.protocolVersion,
  });
  return `${WORKFLOW_VERSION_ID_PREFIX}${sha256Hex(canonical)}`;
}

import { fail } from './errors.js';
import { SUPPORTED_WORKFLOW_IR_SCHEMA_VERSIONS } from '../types.js';
import type { WorkflowIRVersionNegotiation } from '../types.js';

/**
 * V2-003 — WorkflowIR schema-version negotiation.
 *
 * The library interprets EXACTLY the schema versions it implements
 * (SUPPORTED_WORKFLOW_IR_SCHEMA_VERSIONS). A document from a NEWER schema
 * fails closed with UNSUPPORTED_SCHEMA_VERSION — never silently reinterpreted
 * — even when a caller claims support for it (the caller may speak more
 * protocol versions than this library can interpret).
 */

/** A positive integer schema version, or throw. */
export function assertValidSchemaVersion(version: unknown, label: string): number {
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version <= 0 ||
    Object.is(version, -0)
  ) {
    throw new Error(
      `${label} must be a positive integer schema version, got ${String(version)}`,
    );
  }
  return version;
}

/**
 * Protocol-level advisory negotiation between a producer's schema version and
 * a consumer's declared supported set (the public negotiation surface pinned
 * by ir-boundary/ir-compatibility):
 * - `exact` — the consumer lists the producer version;
 * - `backward` — the producer is older than the consumer's maximum;
 * - `incompatible/producer_newer_than_consumer` — the producer is newer than
 *   every consumer version;
 * - `incompatible/invalid_consumer_set` — fail closed on an empty consumer set.
 */
export function negotiateWorkflowIRSchemaVersion(
  producerVersion: number,
  consumerVersions: readonly number[],
): WorkflowIRVersionNegotiation {
  assertValidSchemaVersion(producerVersion, 'producerVersion');
  if (!Array.isArray(consumerVersions)) {
    throw new Error('consumerVersions must be an array of positive integer schema versions');
  }
  for (const version of consumerVersions) {
    assertValidSchemaVersion(version, 'consumerVersions entry');
  }
  if (consumerVersions.length === 0) {
    return { status: 'incompatible', reason: 'invalid_consumer_set' };
  }
  if (consumerVersions.includes(producerVersion)) {
    return { status: 'compatible', mode: 'exact' };
  }
  const consumerMaximum = Math.max(...consumerVersions);
  if (producerVersion < consumerMaximum) {
    return { status: 'compatible', mode: 'backward' };
  }
  return { status: 'incompatible', reason: 'producer_newer_than_consumer' };
}

/**
 * Enforce the schema-version boundary at validation time: the document
 * version must be interpretable by THIS library and must be consumable under
 * the caller's declared set. Fail closed otherwise.
 */
export function checkSchemaVersionAcceptable(
  schemaVersion: number,
  callerSupported: readonly number[] | undefined,
): void {
  const consumerSet = callerSupported ?? SUPPORTED_WORKFLOW_IR_SCHEMA_VERSIONS;
  if (!Array.isArray(consumerSet)) {
    fail(
      'UNSUPPORTED_SCHEMA_VERSION',
      'supportedSchemaVersions must be an array; negotiate a common schema version',
    );
  }
  for (const version of consumerSet) {
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version <= 0 ||
      Object.is(version, -0)
    ) {
      fail(
        'UNSUPPORTED_SCHEMA_VERSION',
        `invalid supportedSchemaVersions entry ${String(version)}; entries must be positive integers (see negotiateWorkflowIRSchemaVersion)`,
      );
    }
  }
  if (consumerSet.length === 0) {
    fail(
      'UNSUPPORTED_SCHEMA_VERSION',
      'empty supportedSchemaVersions set; use negotiateWorkflowIRSchemaVersion to negotiate a common schema version',
    );
  }
  if (!SUPPORTED_WORKFLOW_IR_SCHEMA_VERSIONS.includes(schemaVersion)) {
    fail(
      'UNSUPPORTED_SCHEMA_VERSION',
      `schema version ${schemaVersion} is not interpretable by this library (supported: ${SUPPORTED_WORKFLOW_IR_SCHEMA_VERSIONS.join(', ')}); negotiate a common schema version before exchange`,
    );
  }
  const negotiation = negotiateWorkflowIRSchemaVersion(schemaVersion, consumerSet);
  if (negotiation.status === 'incompatible') {
    fail(
      'UNSUPPORTED_SCHEMA_VERSION',
      `schema version negotiation failed (${negotiation.reason}); negotiate a common schema version before exchange`,
    );
  }
}

/**
 * V2-004 — Deterministic canonical serialization and crypto primitives.
 *
 * Canonical JSON (V2-CTRL-003 `digest` rules): UTF-8 JSON with deterministic
 * object-key ordering, no insignificant whitespace, array order preserved
 * (only schemas that declare sets normalize order — this module's consumers
 * treat execution-class lists as ordered content). Presentation formatting is
 * never hashed. SHA-256 and HMAC-SHA256 are provided by node:crypto.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Canonical JSON string of a JSON value (sorted keys, no whitespace). */
export function canonicalJsonStringify(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return JSON.stringify(value);
    case 'boolean':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      // undefined / functions / symbols are not canonicalizable JSON values.
      return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => serialize(element)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const members = keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`);
  return `{${members.join(',')}}`;
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** HMAC-SHA256 hex digest of a message under a UTF-8 secret. */
export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/** Timing-safe equality of two hex digests of equal length. */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

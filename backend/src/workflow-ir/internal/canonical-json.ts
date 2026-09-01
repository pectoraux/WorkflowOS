/**
 * V2-003 — canonical JSON serialization.
 *
 * Implements the registry's "Canonical identity and digest rules"
 * (V2-CTRL-003): UTF-8 JSON with deterministic object-key ordering, no
 * insignificant whitespace, and normalized primitive representations.
 * Presentation formatting (pretty-printing, key order, array order of
 * non-set fields, unicode escape style) never reaches the canonical bytes.
 *
 * Non-deterministic or non-JSON values (undefined, functions, symbols,
 * non-plain objects, NaN, ±Infinity, -0) are REJECTED rather than silently
 * coerced — canonical bytes must be reproducible.
 */

/** Is `value` a plain JSON object (Object.prototype or null prototype)? */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Serialize `value` to canonical JSON: keys sorted lexicographically (code
 * unit order) at every level, no whitespace, deterministic primitives.
 * Throws on values that canonical JSON cannot represent deterministically.
 */
export function canonicalJsonString(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('canonical JSON rejects non-finite numbers');
      }
      if (Object.is(value, -0)) {
        throw new Error('canonical JSON rejects negative zero');
      }
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((element) => serializeCanonical(element)).join(',')}]`;
      }
      if (isPlainObject(value)) {
        const keys = Object.keys(value).sort();
        const parts: string[] = [];
        for (const key of keys) {
          if (value[key] === undefined) {
            throw new Error('canonical JSON rejects undefined property values');
          }
          parts.push(`${JSON.stringify(key)}:${serializeCanonical(value[key])}`);
        }
        return `{${parts.join(',')}}`;
      }
      throw new Error('canonical JSON rejects non-plain objects');
    default:
      // undefined, function, symbol, bigint
      throw new Error(`canonical JSON rejects ${typeof value} values`);
  }
}

/** Is `value` fully representable as deterministic canonical JSON? */
export function isCanonicalJsonSafe(value: unknown): boolean {
  try {
    serializeCanonical(value);
    return true;
  } catch {
    return false;
  }
}

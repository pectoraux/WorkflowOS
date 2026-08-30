import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing (WORK-074 email/password provider).
 *
 * Uses scrypt (node:crypto — no extra dependencies). The raw password is
 * NEVER persisted; only a salted scrypt-derived digest is stored
 * (`wfos_user_passwords.password_hash`, SEC-AC-02). A database leak does NOT
 * expose usable credentials.
 *
 * The digest format is `scrypt:N: saltHex:hashHex` where N is the scrypt key
 * length. Verification re-derives the digest from the presented password and
 * compares in constant time. The raw password is discarded immediately after
 * hashing — it is never logged, never persisted, never returned.
 */

const SCRYPT_KEY_LEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PREFIX = 'scrypt';

/**
 * Hash a raw password into a salted scrypt digest. The caller MUST discard the
 * raw password immediately; only the returned digest is persisted.
 */
export function hashPassword(rawPassword: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(rawPassword, salt, SCRYPT_KEY_LEN, SCRYPT_PARAMS);
  return `${PREFIX}:${SCRYPT_KEY_LEN}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Verify a presented raw password against a stored scrypt digest. Constant-time
 * comparison. Returns false (never throws) for an invalid digest format or a
 * non-matching password.
 */
export function verifyPassword(rawPassword: string, storedDigest: string): boolean {
  const parts = storedDigest.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return false;
  const keyLen = Number(parts[1]);
  if (!Number.isInteger(keyLen) || keyLen <= 0 || keyLen > 1024) return false;
  const salt = Buffer.from(parts[2]!, 'hex');
  const expected = Buffer.from(parts[3]!, 'hex');
  if (salt.length === 0 || expected.length !== keyLen) return false;
  try {
    const derived = scryptSync(rawPassword, salt, keyLen, SCRYPT_PARAMS);
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

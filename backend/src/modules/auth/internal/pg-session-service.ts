import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseClient } from '@platform/index.js';
import type {
  Session,
  SessionService,
  SessionToken,
  CreateSessionInput,
  VerifiedSession,
  PrincipalKind,
} from './identity-runtime.types.js';

/**
 * PostgreSQL-backed {@link SessionService} (WORK-063 invariant #5).
 *
 * The session token is a 32-byte high-entropy random value, base64url-encoded.
 * Only its SHA-256 digest is persisted (`wfos_sessions.token_digest`). The raw
 * token lives ONLY in the httpOnly cookie set by the auth route; it is never
 * persisted (SEC-AC-02).
 *
 * PostgreSQL is authoritative for session state (WORK-063 invariant #14). A
 * revoked session (revoked_at set) is rejected on the next verify; an expired
 * session (expires_at < now) is rejected. Logout actually removes access.
 */

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const TOKEN_BYTES = 32;

export class PgSessionService implements SessionService {
  constructor(private readonly db: DatabaseClient) {}

  async create(
    input: CreateSessionInput,
  ): Promise<{ token: SessionToken; session: Session }> {
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const rawToken = randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenDigest = sha256Hex(rawToken);
    const result = await this.db.query<SessionRow>(
      `INSERT INTO wfos_sessions (user_id, token_digest, principal_kind, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), $5, $6)
       RETURNING id, user_id, token_digest, principal_kind, created_at, expires_at, revoked_at, last_used_at, user_agent, ip_address`,
      [
        input.userId,
        tokenDigest,
        input.principalKind,
        ttl,
        input.userAgent ?? null,
        input.ipAddress ?? null,
      ],
    );
    const session = mapRow(result.rows[0]!);
    return { token: rawToken, session };
  }

  async verify(token: SessionToken): Promise<VerifiedSession> {
    if (!token || token.length === 0) {
      return { session: nullSession(), valid: false, invalidReason: 'not-found' };
    }
    const tokenDigest = sha256Hex(token);
    const result = await this.db.query<SessionRow>(
      `UPDATE wfos_sessions
         SET last_used_at = NOW()
       WHERE token_digest = $1 AND revoked_at IS NULL AND expires_at > NOW()
       RETURNING id, user_id, token_digest, principal_kind, created_at, expires_at, revoked_at, last_used_at, user_agent, ip_address`,
      [tokenDigest],
    );
    if (result.rows.length === 0) {
      // Distinguish not-found from expired/revoked for typed denial evidence.
      const lookup = await this.db.query<SessionRow>(
        'SELECT revoked_at, expires_at FROM wfos_sessions WHERE token_digest = $1',
        [tokenDigest],
      );
      if (lookup.rows.length === 0) {
        return { session: nullSession(), valid: false, invalidReason: 'not-found' };
      }
      const row = lookup.rows[0]!;
      if (row.revoked_at) {
        return { session: nullSession(), valid: false, invalidReason: 'revoked' };
      }
      return { session: nullSession(), valid: false, invalidReason: 'expired' };
    }
    return { session: mapRow(result.rows[0]!), valid: true };
  }

  async revoke(token: SessionToken): Promise<void> {
    if (!token) return;
    const tokenDigest = sha256Hex(token);
    await this.db.query(
      'UPDATE wfos_sessions SET revoked_at = NOW() WHERE token_digest = $1 AND revoked_at IS NULL',
      [tokenDigest],
    );
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.db.query(
      'UPDATE wfos_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    return result.rowCount ?? 0;
  }
}

interface SessionRow {
  id: string;
  user_id: string;
  token_digest: string;
  principal_kind: PrincipalKind;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  user_agent: string | null;
  ip_address: string | null;
}

function mapRow(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tokenDigest: row.token_digest,
    principalKind: row.principal_kind,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    userAgent: row.user_agent,
    ipAddress: row.ip_address,
  };
}

function nullSession(): Session {
  return {
    id: '',
    userId: '',
    tokenDigest: '',
    principalKind: 'human',
    createdAt: new Date(0),
    expiresAt: new Date(0),
    revokedAt: null,
    lastUsedAt: null,
    userAgent: null,
    ipAddress: null,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

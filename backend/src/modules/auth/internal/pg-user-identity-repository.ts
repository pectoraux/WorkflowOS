import type { DatabaseClient } from '@platform/index.js';
import type {
  UserIdentity,
  UserIdentityRepository,
  UserPasswordRepository,
} from './identity-runtime.types.js';

/**
 * PostgreSQL-backed {@link UserIdentityRepository} (WORK-063 proof #3 —
 * identity linking). Multiple provider identities (google, github, email) may
 * link to one user; a linked re-login resolves to the SAME user.
 */
export class PgUserIdentityRepository implements UserIdentityRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findByProviderAndSubject(
    provider: string,
    subject: string,
  ): Promise<UserIdentity | null> {
    const result = await this.db.query<UserIdentityRow>(
      `SELECT id, user_id, provider, subject, created_at
         FROM wfos_user_identities WHERE provider = $1 AND subject = $2`,
      [provider, subject],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  async link(
    userId: string,
    provider: string,
    subject: string,
  ): Promise<UserIdentity> {
    const result = await this.db.query<UserIdentityRow>(
      `INSERT INTO wfos_user_identities (user_id, provider, subject)
       VALUES ($1, $2, $3)
       ON CONFLICT (provider, subject) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id, user_id, provider, subject, created_at`,
      [userId, provider, subject],
    );
    return mapRow(result.rows[0]!);
  }

  async listForUser(userId: string): Promise<UserIdentity[]> {
    const result = await this.db.query<UserIdentityRow>(
      `SELECT id, user_id, provider, subject, created_at
         FROM wfos_user_identities WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    );
    return result.rows.map(mapRow);
  }
}

/**
 * PostgreSQL-backed {@link UserPasswordRepository} (DIGEST ONLY — SEC-AC-02).
 *
 * Stores ONLY the scrypt-derived password digest. The raw password is NEVER
 * persisted, NEVER logged, NEVER returned.
 */
export class PgUserPasswordRepository implements UserPasswordRepository {
  constructor(private readonly db: DatabaseClient) {}

  async setForUser(userId: string, passwordHash: string): Promise<void> {
    await this.db.query(
      `INSERT INTO wfos_user_passwords (user_id, password_hash, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`,
      [userId, passwordHash],
    );
  }

  async getForUser(userId: string): Promise<string | null> {
    const result = await this.db.query<{ password_hash: string }>(
      'SELECT password_hash FROM wfos_user_passwords WHERE user_id = $1',
      [userId],
    );
    if (result.rows.length === 0) return null;
    return result.rows[0]!.password_hash;
  }
}

interface UserIdentityRow {
  id: string;
  user_id: string;
  provider: string;
  subject: string;
  created_at: Date;
}

function mapRow(row: UserIdentityRow): UserIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    subject: row.subject,
    createdAt: row.created_at,
  };
}

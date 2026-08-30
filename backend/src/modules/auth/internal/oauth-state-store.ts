import { randomBytes } from 'node:crypto';
import type { DatabaseClient } from '@platform/index.js';

/**
 * WORK-074 — the server-side OAuth authorization-request state store (the
 * callback CSRF contract). Before redirecting the browser to a provider, the
 * /auth route mints a cryptographically random state and records it here
 * (provider-bound, short-lived). The callback MUST present a state that:
 *   - exists, is unexpired, AND matches the provider;
 *   - is consumed atomically on first use (single use — a replayed state is
 *     rejected).
 *
 * The state is a random nonce — not secret material; nothing here is a
 * credential (SEC-AC-01/02 discipline holds).
 */

export interface OAuthStateRecord {
  readonly state: string;
  readonly provider: string;
  readonly redirectTo: string;
  readonly expiresAt: Date;
}

export interface OAuthStateStore {
  /** Mint + persist a fresh single-use state for `provider`. */
  create(input: { provider: string; redirectTo: string; ttlSeconds?: number }): Promise<OAuthStateRecord>;
  /**
   * Atomically consume `state` for `provider`. Returns the record when the
   * state is valid (known, unexpired, provider-matching) — and deletes it so
   * it cannot be used again. Returns null when unknown/expired/mismatched.
   */
  consume(state: string, provider: string): Promise<OAuthStateRecord | null>;
}

const DEFAULT_TTL_SECONDS = 600; // 10 minutes

export class PgOAuthStateStore implements OAuthStateStore {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    provider: string;
    redirectTo: string;
    ttlSeconds?: number;
  }): Promise<OAuthStateRecord> {
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const state = randomBytes(32).toString('hex');
    const result = await this.db.query<StateRow>(
      `INSERT INTO wfos_oauth_states (state, provider, redirect_to, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(secs => $4))
       RETURNING state, provider, redirect_to, expires_at`,
      [state, input.provider, input.redirectTo, ttl],
    );
    const row = result.rows[0]!;
    return {
      state: row.state,
      provider: row.provider,
      redirectTo: row.redirect_to,
      expiresAt: row.expires_at,
    };
  }

  async consume(state: string, provider: string): Promise<OAuthStateRecord | null> {
    if (!state) return null;
    // DELETE ... RETURNING is the atomic single-use consume: two concurrent
    // callbacks with the same state — exactly one gets the row.
    const result = await this.db.query<StateRow>(
      `DELETE FROM wfos_oauth_states
       WHERE state = $1 AND provider = $2 AND expires_at > NOW()
       RETURNING state, provider, redirect_to, expires_at`,
      [state, provider],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0]!;
    return {
      state: row.state,
      provider: row.provider,
      redirectTo: row.redirect_to,
      expiresAt: row.expires_at,
    };
  }
}

interface StateRow {
  state: string;
  provider: string;
  redirect_to: string;
  expires_at: Date;
}

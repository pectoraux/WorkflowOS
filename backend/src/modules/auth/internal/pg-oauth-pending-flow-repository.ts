import type { DatabaseClient } from '@platform/index.js';

/**
 * WORK-074 (OAuth browser-binding hardening) — the server-side pending
 * OAuth flow record.
 *
 * The original WORK-074 runtime stored the OAuth `state` only in a browser
 * cookie and checked `query.state === cookie.state` on the callback. That
 * proves only cookie possession — NOT a durable correlation to a distinct
 * login transaction, and it offers NO replay protection.
 *
 * This repository persists the pending flow server-side, bound to a
 * browser-binding secret (the raw secret lives ONLY in the httpOnly
 * `wfos_oauth_flow` cookie; the server stores only its SHA-256 digest —
 * SEC-AC-02). The callback verifies the flow exists, is not expired, the
 * browser-binding matches, and (atomically) is not yet consumed — closing
 * the cross-browser and replay gaps.
 *
 * PostgreSQL is authoritative (WORK-063 invariant #14). The raw
 * browser-binding secret is NEVER stored.
 */

export interface OAuthPendingFlow {
  readonly id: string;
  readonly state: string;
  readonly provider: string;
  /** SHA-256 digest of the browser-binding secret (the raw secret is in the cookie). */
  readonly browserBinding: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface CreatePendingFlowInput {
  state: string;
  provider: string;
  /** SHA-256 digest of the browser-binding secret (the caller computes it). */
  browserBinding: string;
  /** Lifetime in seconds (default 10 minutes — matches the cookie max-age). */
  ttlSeconds?: number;
}

export interface ConsumeResult {
  /** 'consumed' — the caller wins; the flow is now marked consumed. */
  readonly kind: 'consumed';
  readonly flow: OAuthPendingFlow;
  /** 'unknown' — no pending flow with that state exists. */
}
export interface ConsumeUnknown {
  readonly kind: 'unknown' | 'expired' | 'replay' | 'browser-mismatch';
  readonly reason: string;
}

export type ConsumePendingFlowResult = ConsumeResult | ConsumeUnknown;

export interface OAuthPendingFlowRepository {
  /**
   * Insert a pending flow. The state is UNIQUE — a duplicate insert (e.g. a
   * retry of /auth/login with a colliding state) is rejected by the DB.
   */
  create(input: CreatePendingFlowInput): Promise<OAuthPendingFlow>;

  /**
   * Atomically consume a pending flow for `(state, provider, browserBinding)`.
   *
   * The atomic UPDATE ... WHERE consumed_at IS NULL ensures exactly one
   * consumer wins, even under a concurrent replay of the same callback:
   * the second consumer's UPDATE hits 0 rows (consumed_at is already set) →
   * `replay`. The browser-binding digest is part of the WHERE clause so a
   * cross-browser presentation (Browser B with a different/no flow cookie)
   * is rejected with `browser-mismatch` BEFORE the consume.
   *
   * Returns:
   *   - 'consumed' — the caller wins; proceed to exchange the code.
   *   - 'unknown' — no pending flow with that state exists.
   *   - 'expired' — the flow exists but expires_at < NOW().
   *   - 'browser-mismatch' — the flow exists but the browser-binding digest
   *     does not match (cross-browser presentation).
   *   - 'replay' — the flow exists, the browser matches, but it was already
   *     consumed (replay of the same callback).
   */
  consume(input: {
    state: string;
    provider: string;
    browserBinding: string;
  }): Promise<ConsumePendingFlowResult>;

  /** Look up a pending flow by state (for tests/inspection; does NOT consume). */
  findByState(state: string): Promise<OAuthPendingFlow | null>;

  /** Delete expired, consumed flows (housekeeping — not required for correctness). */
  purgeExpired(now?: Date): Promise<number>;
}

export class PgOAuthPendingFlowRepository implements OAuthPendingFlowRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreatePendingFlowInput): Promise<OAuthPendingFlow> {
    const ttl = input.ttlSeconds ?? 10 * 60;
    const result = await this.db.query<PendingFlowRow>(
      `INSERT INTO wfos_oauth_pending_flows (state, provider, browser_binding, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(secs => $4))
       RETURNING id, state, provider, browser_binding, created_at, expires_at, consumed_at`,
      [input.state, input.provider, input.browserBinding, ttl],
    );
    return mapRow(result.rows[0]!);
  }

  async consume(input: {
    state: string;
    provider: string;
    browserBinding: string;
  }): Promise<ConsumePendingFlowResult> {
    // First, look up the flow WITHOUT consuming, to distinguish the typed
    // denial reasons (unknown / expired / browser-mismatch / replay).
    const lookup = await this.db.query<PendingFlowRow>(
      `SELECT id, state, provider, browser_binding, created_at, expires_at, consumed_at
         FROM wfos_oauth_pending_flows WHERE state = $1`,
      [input.state],
    );
    if (lookup.rows.length === 0) {
      return { kind: 'unknown', reason: 'no pending flow with that state' };
    }
    const row = lookup.rows[0]!;
    if (row.provider !== input.provider) {
      // Defense in depth: the provider in the URL must match the flow's provider.
      return { kind: 'unknown', reason: 'provider mismatch' };
    }
    if (Number(new Date(row.expires_at)) <= Number(/* now */ new Date())) {
      return { kind: 'expired', reason: 'pending flow expired' };
    }
    if (row.browser_binding !== input.browserBinding) {
      // Cross-browser presentation: Browser B does not have Browser A's
      // wfos_oauth_flow cookie → its digest does not match.
      return { kind: 'browser-mismatch', reason: 'browser-binding mismatch (cross-browser presentation rejected)' };
    }
    if (row.consumed_at !== null) {
      // Replay: the flow was already consumed by a prior callback.
      return { kind: 'replay', reason: 'pending flow already consumed (replay rejected)' };
    }
    // Atomic consume: UPDATE ... WHERE consumed_at IS NULL. Under a concurrent
    // replay, exactly one of the two UPDATEs hits 1 row; the other hits 0.
    const consume = await this.db.query<PendingFlowRow>(
      `UPDATE wfos_oauth_pending_flows
         SET consumed_at = NOW()
       WHERE state = $1 AND provider = $2 AND browser_binding = $3
         AND consumed_at IS NULL AND expires_at > NOW()
       RETURNING id, state, provider, browser_binding, created_at, expires_at, consumed_at`,
      [input.state, input.provider, input.browserBinding],
    );
    if (consume.rows.length === 0) {
      // Lost the race — a concurrent callback consumed it first.
      return { kind: 'replay', reason: 'pending flow already consumed (concurrent replay rejected)' };
    }
    return { kind: 'consumed', flow: mapRow(consume.rows[0]!) };
  }

  async findByState(state: string): Promise<OAuthPendingFlow | null> {
    const result = await this.db.query<PendingFlowRow>(
      `SELECT id, state, provider, browser_binding, created_at, expires_at, consumed_at
         FROM wfos_oauth_pending_flows WHERE state = $1`,
      [state],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  async purgeExpired(now: Date = new Date()): Promise<number> {
    const result = await this.db.query(
      'DELETE FROM wfos_oauth_pending_flows WHERE expires_at < $1 OR consumed_at IS NOT NULL',
      [now],
    );
    return result.rowCount ?? 0;
  }
}

interface PendingFlowRow {
  id: string;
  state: string;
  provider: string;
  browser_binding: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

function mapRow(row: PendingFlowRow): OAuthPendingFlow {
  return {
    id: row.id,
    state: row.state,
    provider: row.provider,
    browserBinding: row.browser_binding,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

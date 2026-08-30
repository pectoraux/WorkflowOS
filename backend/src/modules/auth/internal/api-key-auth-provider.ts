import { createHash } from 'node:crypto';
import type {
  AuthProvider,
  AuthenticatedPrincipal,
  AuthenticationResult,
} from './auth.types.js';
import type { SecretStore } from '@platform/secrets/secret-store.js';
import type { DatabaseClient } from '@platform/index.js';

/**
 * API-key-backed {@link AuthProvider} (AUTH-001).
 *
 * Provider-independent: domain logic depends on {@link AuthProvider}, never on
 * this class. The composition root constructs it; the AuthProvider abstraction
 * is what the API plugin consumes.
 *
 * Credential material is accessed ONLY through the {@link SecretStore}
 * abstraction (SEC-AC-01). Raw keys are NEVER stored in domain/workflow
 * records — only an opaque {@link ApiKeyCredentialRef} (key id + secret
 * reference). The reference is matched against a presented credential by
 * hashing the presented value and comparing, so the raw key never leaves the
 * SecretStore boundary during verification.
 *
 * The API-key credential registry is a small infrastructure table owned by
 * /auth (`wfos_api_key_credentials`) created by migration 0003 and EXTENDED
 * by migration 0059 (service_account_id + scopes). It holds:
 *   - key_id (stable id, safe to log)
 *   - secret_ref (opaque SecretStore reference — env var name / key id)
 *   - external_id (principal this key authenticates)
 *   - label (human-readable, safe to log)
 *   - key_digest (SHA-256 of the raw key, for constant-time comparison)
 *   - service_account_id (WORK-074 — when set, the key authenticates a
 *     MACHINE principal; the service account's capability set + the
 *     credential's scopes govern authorization)
 *   - scopes (WORK-074 — explicit capability scopes; the credential's
 *     EFFECTIVE capability set is the intersection of the service account's
 *     capabilities and these scopes — fail closed)
 *
 * Storing a digest (not the raw key) means a database leak does NOT expose
 * usable credentials (SEC-AC-02).
 */

const API_KEY_TABLE = 'wfos_api_key_credentials';

export class ApiKeyAuthProvider implements AuthProvider {
  readonly name = 'apikey';

  constructor(
    private readonly db: DatabaseClient,
    private readonly secrets: SecretStore,
  ) {}

  async authenticate(rawCredential: string): Promise<AuthenticationResult> {
    const resolved = await this.resolveCredential(rawCredential);
    if (!resolved) {
      if (!rawCredential || rawCredential.length === 0) {
        return { kind: 'unauthenticated', reason: 'missing-credentials' };
      }
      return { kind: 'unauthenticated', reason: 'invalid-credentials' };
    }
    const principal: AuthenticatedPrincipal = {
      externalId: resolved.externalId,
      label: resolved.label,
      provider: this.name,
    };
    return { kind: 'principal', principal };
  }

  /**
   * Resolve a presented raw key to its full credential record (external id,
   * label, service account id, scopes). Returns null when the key is unknown
   * or the SecretStore value does not match (defense in depth, SEC-AC-01).
   *
   * WORK-074: the caller (RequestAuthenticator) uses `serviceAccountId` to
   * decide HUMAN vs MACHINE resolution. Raw key material is NEVER returned.
   */
  async resolveCredential(rawCredential: string): Promise<ResolvedCredential | null> {
    if (!rawCredential || rawCredential.length === 0) return null;
    const presentedDigest = sha256Hex(rawCredential);
    const result = await this.db.query<CredentialRow>(
      `SELECT key_id, secret_ref, external_id, label, service_account_id, scopes
         FROM ${API_KEY_TABLE} WHERE key_digest = $1`,
      [presentedDigest],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0]!;
    // Double-check the raw value against the secret store (defense in depth).
    const storedRaw = await this.secrets.getSecret({ key: row.secret_ref });
    if (storedRaw !== rawCredential) return null;
    return {
      keyId: row.key_id,
      externalId: row.external_id,
      label: row.label,
      serviceAccountId: row.service_account_id ?? null,
      scopes: row.scopes ?? [],
    };
  }
}

export interface ResolvedCredential {
  keyId: string;
  externalId: string;
  label: string;
  serviceAccountId: string | null;
  scopes: readonly string[];
}

interface CredentialRow {
  key_id: string;
  secret_ref: string;
  external_id: string;
  label: string;
  service_account_id: string | null;
  scopes: string[] | null;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

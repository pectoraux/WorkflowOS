/**
 * V2-004 — Node identity and authenticated registration key material.
 *
 * Deterministic IDs derive ONLY from authoritative identity inputs
 * (V2-CTRL-003 identity rules): node key fingerprint + owner principal +
 * platform class — never from capabilities, session state, UI state or
 * random material. Host key material is delivered out-of-band through the
 * NodeKeyDirectory (secretRef indirection) and NEVER enters protocol
 * payloads: the registration HMAC authenticates the payload while the
 * secret itself stays host-side.
 */
import type {
  NodeIdentityInputs,
  NodeKeyDirectory,
  NodeKeyDirectoryEntry,
  NodeRegistrationRequest,
  RegistrationAuth,
} from '../types.js';
import { canonicalJsonStringify, hmacSha256Hex, sha256Hex } from './canonical-json.js';

/** Domain separation for node key fingerprint derivation. */
const KEY_FINGERPRINT_DOMAIN = 'workflowos/node-key-fingerprint/v1';

/** Domain separation for node id derivation. */
const NODE_ID_DOMAIN = 'workflowos/node-id/v1';

/**
 * Deterministic one-way fingerprint of host key material (SHA-256,
 * domain-separated). The fingerprint is protocol-visible; the secret is not.
 */
export function deriveNodeKeyFingerprint(secret: string): string {
  return sha256Hex(`${KEY_FINGERPRINT_DOMAIN}:${secret}`);
}

/**
 * Deterministic node id: `node_<sha256-hex>` over the canonical JSON of the
 * authoritative identity inputs. Same inputs → identical id, everywhere.
 */
export function computeNodeId(inputs: NodeIdentityInputs): string {
  const canonicalIdentity = canonicalJsonStringify({
    keyFingerprint: inputs.keyFingerprint,
    ownerPrincipal: inputs.ownerPrincipal,
    platformClass: inputs.platformClass,
  });
  return `node_${sha256Hex(`${NODE_ID_DOMAIN}:${canonicalIdentity}`)}`;
}

/**
 * Registration payload signature: HMAC-SHA256 over the canonical JSON of the
 * payload WITHOUT the auth field. Deterministic for fixed payload + secret.
 */
export function signRegistrationPayload(
  payload: Omit<NodeRegistrationRequest, 'auth'>,
  secret: string,
): RegistrationAuth {
  return {
    algorithm: 'hmac-sha256',
    digest: hmacSha256Hex(secret, canonicalJsonStringify(payload)),
  };
}

/**
 * Out-of-band key directory: maps key fingerprints to host-side secrets.
 * Deliberately the ONLY place host key material exists in this domain.
 */
export function createNodeKeyDirectory(entries: readonly NodeKeyDirectoryEntry[]): NodeKeyDirectory {
  const byFingerprint = new Map<string, string>();
  for (const entry of entries) {
    byFingerprint.set(entry.keyFingerprint, entry.secret);
  }
  return {
    resolve(keyFingerprint: string): string | null {
      return byFingerprint.get(keyFingerprint) ?? null;
    },
  };
}

/**
 * auth module — public interface.
 *
 * Canonical name: /auth
 * Responsibility (spec/architecture.md): Authentication, WorkflowOS user identity boundary (paired with /users).
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-002: exposes the provider-independent authentication + authorization
 * contracts ({@link AuthProvider}, {@link AuthorizationService}) consumed by
 * the API layer and future modules.
 *
 * WORK-074: extends the public surface with the runtime identity layer
 * WORK-063 specified — sessions, service accounts, the capability →
 * permission mapping, the OAuth/email provider adapters, identity linking,
 * and the request authenticator that resolves a session cookie OR an API key
 * to a Principal (human OR machine). All behind the SAME /auth boundary —
 * a new provider is a new adapter, never a new authority.
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  AuthenticatedPrincipal,
  AuthenticationResult,
  AuthProvider,
  ProtectedResource,
  AuthorizationDecision,
  OrganizationAuthorizationDecision,
  AuthorizationService,
  ApiKeyCredentialRef,
} from './internal/auth.types.js';
export type {
  ProvisionApiKeyInput,
  ProvisionedApiKey,
  ApiKeyCredentialProvisioner,
} from './internal/authorization-service.js';
// WORK-074 runtime identity contracts (the runtime of WORK-063's spec).
export type {
  Principal,
  HumanPrincipal,
  MachinePrincipal,
  Session,
  SessionToken,
  SessionService,
  CreateSessionInput,
  VerifiedSession,
  PrincipalKind,
  ServiceAccount,
  CreateServiceAccountInput,
  ServiceAccountRepository,
  CapabilityPermissionRepository,
  OAuthProvider,
  OAuthHttpClient,
  ExternalIdentity,
  UserIdentity,
  UserIdentityRepository,
  UserPasswordRepository,
  Organization,
} from './internal/identity-runtime.types.js';
export type {
  EmailAuthProvider,
  EmailSignupInput,
  EmailSignupResult,
  EmailProviderConfig,
  EmailAuthError,
} from './internal/email-auth-provider.js';
export type {
  GoogleOidcProvider,
  GitHubOAuthProvider,
  OAuthProviderConfig,
} from './internal/oauth-provider.js';
export type { IdentityResolver } from './internal/identity-resolver.js';
export type { RequestAuthenticator } from './internal/request-authenticator.js';
// WORK-074 (OAuth browser-binding hardening): the server-side pending OAuth
// flow record — binds a callback to the distinct login transaction that
// started it + provides one-time-use (replay) protection.
export type {
  OAuthPendingFlow,
  OAuthPendingFlowRepository,
  CreatePendingFlowInput,
  ConsumePendingFlowResult,
} from './internal/pg-oauth-pending-flow-repository.js';

/**
 * Public capabilities exposed by the /auth module to other modules.
 */
export interface AuthModuleApi {
  // future: additional auth-domain methods consumed by other modules
}

/**
 * Frozen module contract for /auth.
 */
export const authModule: ModuleContract & AuthModuleApi = {
  name: '/auth',
};

export default authModule;

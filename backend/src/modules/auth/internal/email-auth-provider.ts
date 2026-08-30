import type { UserRepository, User } from '@modules/users/index.js';
import type {
  UserIdentityRepository,
  UserPasswordRepository,
} from './identity-runtime.types.js';
import { hashPassword, verifyPassword } from './password-hash.js';

/**
 * Email/password authentication provider (WORK-074 — the email provider
 * authorized by WORK-063).
 *
 * This is the smallest production-appropriate email implementation: a salted
 * scrypt digest (node:crypto, no extra deps), digest-only storage, deterministic
 * identity resolution. The raw password is NEVER persisted, NEVER logged,
 * NEVER returned (SEC-AC-02).
 *
 * A new provider is a new adapter behind the existing /auth boundary, never a
 * new authority (WORK-063). This adapter produces the same resolved-user
 * outcome the OAuth adapters produce; the AuthorizationService is unchanged.
 */

export interface EmailSignupInput {
  email: string;
  password: string;
  displayName?: string;
}

export interface EmailSignupResult {
  user: User;
  /** Whether a new user was created (true) or an existing one was adopted. */
  created: boolean;
}

export interface EmailProviderConfig {
  /** Minimum password length (default 8). */
  minPasswordLength?: number;
}

export class EmailAuthProvider {
  readonly name = 'email';

  constructor(
    private readonly users: UserRepository,
    private readonly identities: UserIdentityRepository,
    private readonly passwords: UserPasswordRepository,
    private readonly config: EmailProviderConfig = {},
  ) {}

  /**
   * Sign up a new user with email + password. Creates the user, links the
   * `email` identity, and stores the password digest. Throws on a duplicate
   * email (the identity is already linked to another user) — identity
   * linking across providers is handled by the IdentityResolver, not here.
   */
  async signup(input: EmailSignupInput): Promise<EmailSignupResult> {
    const email = normalizeEmail(input.email);
    if (!isValidEmail(email)) {
      throw new EmailAuthError('invalid-email', 'A valid email is required.');
    }
    const minLen = this.config.minPasswordLength ?? 8;
    if (input.password.length < minLen) {
      throw new EmailAuthError(
        'weak-password',
        `Password must be at least ${minLen} characters.`,
      );
    }

    // The email provider's subject is the lowercased email. AUTH-AC-01
    // deterministic resolution: the same email always resolves to the same
    // user.
    const existing = await this.identities.findByProviderAndSubject(
      'email',
      email,
    );
    if (existing) {
      throw new EmailAuthError(
        'email-already-registered',
        'An account with this email already exists.',
      );
    }

    const user = await this.users.upsertByExternalId({
      externalId: `email:${email}`,
      displayName: input.displayName?.trim() || email,
      email,
    });
    await this.identities.link(user.id, 'email', email);
    await this.passwords.setForUser(user.id, hashPassword(input.password));
    return { user, created: true };
  }

  /**
   * Verify an email + password login. Returns the resolved user, or null if
   * the email is unknown or the password does not match. Never reveals which
   * (avoid user-enumeration): both yield null.
   */
  async verify(email: string, password: string): Promise<User | null> {
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized) || !password) return null;
    const identity = await this.identities.findByProviderAndSubject(
      'email',
      normalized,
    );
    if (!identity) return null;
    const stored = await this.passwords.getForUser(identity.userId);
    if (!stored) return null;
    if (!verifyPassword(password, stored)) return null;
    const user = await this.users.findById(identity.userId);
    return user;
  }
}

export class EmailAuthError extends Error {
  constructor(
    readonly code:
      | 'invalid-email'
      | 'weak-password'
      | 'email-already-registered',
    message: string,
  ) {
    super(message);
    this.name = 'EmailAuthError';
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  // Minimal pragmatic email check — production providers add strict validation.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

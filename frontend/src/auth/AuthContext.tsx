import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { auth, type AuthMe } from '../api/client';

/**
 * WORK-074 — the canonical auth-state source (frontend).
 *
 * The browser NEVER decides whether a user is authorized — the backend is the
 * authority (a 401/403 from the backend is the authority, the WORK-022
 * invariant). This context is the ONE canonical auth-state source on the
 * frontend: it caches "is there an authenticated session/credential" and the
 * resolved user, observed SYNCHRONOUSLY by the App shell and every consumer.
 *
 * Why a single source (WORK-074 proof #15 + the WORK-072 state-ownership
 * defect): the prior per-instance `useState(auth.hasApiKey())` pattern meant a
 * login in the LoginPage updated ITS OWN state but NOT the App shell's, so a
 * successful sign-in required a manual reload before protected routes became
 * visible (dogfooding finding F-3). This context replaces that pattern: a
 * successful sign-in updates the canonical state, and ALL consumers —
 * including the App shell — re-render synchronously with the new state. NO
 * manual reload is required (the empirical proof of F-3 resolved, which
 * WORK-074 proof #15 mandates).
 *
 * Auth method precedence: session (cookie) > api-key (header). The session is
 * the human login path; the API key is the automation path (both first-class,
 * WORK-063 invariant #10). The context initializes from `/auth/me` (session)
 * and falls back to the persisted API key.
 *
 * NOTE on WORK-072 overlap: WORK-072 separately specifies the canonical
 * auth-state source + its discrimination tests. WORK-074 proof #15 REQUIRES
 * the "synchronously observable, no reload" behavior, which necessitates this
 * canonical source. WORK-074 implements the MINIMAL source needed for its own
 * proof; WORK-072's broader discrimination-test suite is NOT implemented here
 * (the overlap is documented, not silently absorbed).
 */

export type AuthMethod = 'session' | 'apikey' | null;

export interface CurrentUser {
  id: string;
  externalId: string;
  displayName: string;
  email: string | null;
}

export interface AuthState {
  /** True when an authenticated session OR a persisted API key is present. */
  isAuthenticated: boolean;
  /** The resolved human user (when authenticated via session). */
  user: CurrentUser | null;
  /** How the current authentication is established. */
  method: AuthMethod;
  /** True while the initial /auth/me check is in flight. */
  loading: boolean;
}

export interface AuthContextValue extends AuthState {
  /** Email/password signup → backend sets the session cookie. */
  signupWithEmail: (email: string, password: string, displayName?: string) => Promise<CurrentUser>;
  /** Email/password login → backend sets the session cookie. */
  loginWithEmail: (email: string, password: string) => Promise<CurrentUser>;
  /** OAuth/OIDC redirect (Google/GitHub) → backend callback sets the cookie. */
  loginWithProvider: (provider: 'google' | 'github') => void;
  /** Set a raw API key (automation path) — persists to localStorage. */
  setApiKey: (key: string) => void;
  /** Revoke the session + clear the API key, then refresh the canonical state. */
  logout: () => Promise<void>;
  /** Force a re-check of /auth/me (used after the OAuth callback redirect). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  // Initial state: if an API key is already persisted (localStorage), the
  // automation path is synchronously authenticated — NO loading delay (the
  // API key is a local credential; the backend is the authority but the
  // state is "a credential has been entered," checked synchronously). Only
  // when there is NO API key do we enter loading to check /auth/me for a
  // browser session cookie.
  const hasApiKeyInitially = auth.hasApiKey();
  const [state, setState] = useState<AuthState>(
    hasApiKeyInitially
      ? { isAuthenticated: true, user: null, method: 'apikey', loading: false }
      : { isAuthenticated: false, user: null, method: null, loading: true },
  );

  const refresh = useCallback(async () => {
    // Check the session first (the human login path).
    const me = await auth.me();
    if (me && me.kind === 'human' && me.user) {
      setState({
        isAuthenticated: true,
        user: toCurrentUser(me.user),
        method: 'session',
        loading: false,
      });
      return;
    }
    // Fall back to the persisted API key (automation path).
    if (auth.hasApiKey()) {
      setState({
        isAuthenticated: true,
        user: null,
        method: 'apikey',
        loading: false,
      });
      return;
    }
    setState({
      isAuthenticated: false,
      user: null,
      method: null,
      loading: false,
    });
  }, []);

  useEffect(() => {
    // Only fetch /auth/me when we don't already have a synchronous API-key
    // credential. When the API key is present, skip the async check entirely
    // (no loading delay — the E2E automation path and a returning API-key
    // user see the app immediately).
    if (hasApiKeyInitially) return;
    void refresh();
  }, [refresh, hasApiKeyInitially]);

  const signupWithEmail = useCallback(
    async (email: string, password: string, displayName?: string) => {
      const user = await auth.signupWithEmail(email, password, displayName);
      // The backend set the session cookie; refresh the canonical state so the
      // App shell re-renders synchronously (no manual reload).
      await refresh();
      return toCurrentUser(user);
    },
    [refresh],
  );

  const loginWithEmail = useCallback(
    async (email: string, password: string) => {
      const user = await auth.loginWithEmail(email, password);
      await refresh();
      return toCurrentUser(user);
    },
    [refresh],
  );

  const loginWithProvider = useCallback((provider: 'google' | 'github') => {
    auth.loginWithProvider(provider);
    // The browser navigates away; on the callback redirect back to '/', the
    // provider mounts fresh and /auth/me resolves the new session.
  }, []);

  const setApiKey = useCallback((key: string) => {
    auth.setApiKey(key);
    // Synchronously update the canonical state — the App shell re-renders.
    setState({
      isAuthenticated: true,
      user: null,
      method: 'apikey',
      loading: false,
    });
  }, []);

  const logout = useCallback(async () => {
    try {
      await auth.logout();
    } catch {
      // Best-effort — the backend may already be unreachable. Still clear.
    }
    auth.clearApiKey();
    setState({
      isAuthenticated: false,
      user: null,
      method: null,
      loading: false,
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signupWithEmail,
      loginWithEmail,
      loginWithProvider,
      setApiKey,
      logout,
      refresh,
    }),
    [state, signupWithEmail, loginWithEmail, loginWithProvider, setApiKey, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthContext must be used within an <AuthProvider>');
  }
  return ctx;
}

function toCurrentUser(u: {
  id: string;
  externalId: string;
  displayName: string;
  email: string | null;
}): CurrentUser {
  return {
    id: u.id,
    externalId: u.externalId,
    displayName: u.displayName,
    email: u.email,
  };
}

export type { AuthMe };

import { useAuthContext } from '../auth/AuthContext';

/**
 * WORK-022 / WORK-074 auth hook.
 *
 * The browser never decides whether a user is authorized — the backend does
 * (a 401/403 is the authority). This hook reads from the ONE canonical
 * auth-state source ({@link useAuthContext} / {@link AuthProvider}). A
 * successful sign-in updates the canonical state, and ALL consumers —
 * including the App shell — re-render synchronously with the new state (NO
 * manual reload required — WORK-074 proof #15).
 *
 * The prior per-instance `useState(auth.hasApiKey())` pattern (the WORK-072
 * defect) is REPLACED by this single source. It is NOT duplicated.
 */
export function useAuth() {
  const ctx = useAuthContext();
  return {
    isAuthenticated: ctx.isAuthenticated,
    user: ctx.user,
    method: ctx.method,
    loading: ctx.loading,
    setApiKey: ctx.setApiKey,
    signupWithEmail: ctx.signupWithEmail,
    loginWithEmail: ctx.loginWithEmail,
    loginWithProvider: ctx.loginWithProvider,
    logout: ctx.logout,
  };
}

/**
 * Generic data-fetching hook.
 *
 * Frontend state is ALWAYS derived from backend/API responses. This hook never
 * owns authoritative state — it just caches the most recent backend response
 * for UX, and exposes loading/error/empty states.
 */
import { useState, useCallback, useEffect } from 'react';
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      setData(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}

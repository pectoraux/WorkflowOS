/**
 * WORK-074 — the HttpOnly session cookie contract (the ONLY session carrier).
 *
 * The browser never sees session state in JS-readable storage: the token is an
 * opaque random value in an HttpOnly cookie, verified server-side against
 * wfos_sessions. Attributes:
 *   - HttpOnly     — invisible to JavaScript (XSS cannot exfiltrate it);
 *   - SameSite=Lax — cross-site POSTs never carry it (CSRF baseline; the API's
 *     CORS is an exact-origin allowlist, never '*');
 *   - Path=/       — the SPA and the /api routes share the origin;
 *   - Secure       — when the deployment is https (production);
 *   - Max-Age      — matches the server-side expiry (refresh re-issues it).
 */

export const SESSION_COOKIE_NAME = 'wfos_session';

export function buildSessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure = false): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

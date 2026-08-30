/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth/AuthContext';

// WORK-074: App now reads auth state from the canonical AuthProvider. Tests
// wrap in <AuthProvider> and mock /auth/me (401 → unauthenticated; the API-key
// fallback handles the "authenticated" case). The login surface is now
// Google/GitHub/email (the demo-key API-key input is demoted — finding F-1).
function mockFetchUnauthenticated(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/auth/me')) {
      return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });
    }
    // Other API calls (projects, organizations) return empty 200s.
    return new Response(JSON.stringify({ organizations: [], projects: [] }), { status: 200 });
  });
}

describe('App router regression — no redirect loop', () => {
  beforeEach(() => {
    localStorage.clear();
    mockFetchUnauthenticated();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('authenticated (API key set)', () => {
    beforeEach(() => {
      localStorage.setItem('wfos_api_key', 'test-api-key');
    });

    it('renders ProjectListPage at `/` (no redirect loop)', async () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
      // Wait for the auth-state check to settle (API-key fallback → authenticated).
      await waitFor(() => expect(getByText('New Project')).toBeInTheDocument());
    });

    it('renders ProjectListPage at `/projects` (route now exists)', async () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/projects']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
      await waitFor(() => expect(getByText('New Project')).toBeInTheDocument());
    });

    it('catch-all redirects unknown routes to `/` (which renders, no loop)', async () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/totally-unknown-path']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
      await waitFor(() => expect(getByText('New Project')).toBeInTheDocument());
    });
  });

  describe('unauthenticated (no API key)', () => {
    it('renders LoginPage at `/`', async () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
      // The new login surface offers Google/GitHub/email.
      await waitFor(() => expect(getByText(/Continue with Google/i)).toBeInTheDocument());
      expect(getByText(/Continue with GitHub/i)).toBeInTheDocument();
    });

    it('renders LoginPage for any path when unauthenticated', async () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/projects/some-id']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
      await waitFor(() => expect(getByText(/Continue with Google/i)).toBeInTheDocument());
    });
  });
});

/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from './LoginPage';
import { AuthProvider } from '@/auth/AuthContext';

// WORK-074: the LoginPage now offers Google/GitHub/email as the primary
// customer-facing login surface. The demo-key API-key input is DEMOTED to an
// "automation" affordance (API keys remain first-class, but they are no longer
// the bootstrap the customer is funneled through — finding F-1 resolved).
describe('LoginPage smoke', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders the human login surface (Google, GitHub, email) as primary', () => {
    // /auth/me is called on mount by AuthProvider; stub it as unauthenticated.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }),
    );
    const { getByText, getByPlaceholderText, queryByText } = render(
      <MemoryRouter>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(getByText(/Continue with Google/i)).toBeInTheDocument();
    expect(getByText(/Continue with GitHub/i)).toBeInTheDocument();
    expect(getByPlaceholderText(/you@example.com/i)).toBeInTheDocument();
    // The API-key input is NOT shown by default (demoted).
    expect(queryByText(/Use an API key instead/i)).toBeInTheDocument();
  });

  it('never exposes a stored API key in the rendered output', () => {
    localStorage.setItem('wfos_api_key', 'super-secret-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }),
    );
    const { queryByText } = render(
      <MemoryRouter>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(queryByText(/super-secret-key/)).not.toBeInTheDocument();
  });
});

/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { auth } from './api/client';

vi.mock('./pages/WorkbenchPage', () => ({
  default: () => <div>Developer Workbench</div>,
}));

function mockAuthenticatedFetch() {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/session')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            user: { id: 'u-1', displayName: 'Alice', email: 'alice@example.com' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

describe('V2-017 product navigation', () => {
  beforeEach(() => {
    auth.handleUnauthorized();
    vi.stubGlobal('fetch', mockAuthenticatedFetch());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['/', /What do you want to get done\?/i],
    ['/workflows', /Workflows/i],
    ['/explore', /Explore/i],
    ['/activity', /Activity/i],
    ['/create', /Create a workflow/i],
    ['/expert', /Expert workspace/i],
  ])('renders the consumer route %s', async (path, heading) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument());
  });

  it('keeps the existing developer workbench reachable behind the expert surface', async () => {
    render(
      <MemoryRouter initialEntries={['/expert']}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('link', { name: /open developer workspace/i })).toHaveAttribute('href', '/projects'));

    render(
      <MemoryRouter initialEntries={['/projects/project-1/workbench']}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Developer Workbench')).toBeInTheDocument());
  });
});

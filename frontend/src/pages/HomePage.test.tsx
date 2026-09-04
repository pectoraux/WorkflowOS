/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import HomePage from './HomePage';

/**
 * V2-017 T2 — the workflow-first Home contract.
 *
 * The dispatch (Issue #179) owns: the primary goal/search/creation entry,
 * the Describe it / Show me / Describe + show entry points, recent
 * workflows, needs-attention, pending approvals, updates, and device
 * issues — each wired surface distinguishing EXPLICITLY between loading,
 * error, successful-empty, and data; surfaces without an exposed
 * authoritative read render an honest "Unavailable" state instead of a
 * fabricated empty one. Failed reads never become successful empty states.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  // Longest fragment first: '/organizations/org-1/workflow-repository/workflows'
  // must match its own handler, not the bare '/organizations' one.
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    for (const [fragment, handler] of ordered) {
      if (url.includes(fragment)) return Promise.resolve(handler());
    }
    return Promise.resolve(jsonResponse(500, { error: `unmocked ${url}` }));
  });
}

function locationProbe() {
  return function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
  };
}

function renderHome(routes: Record<string, RouteHandler>) {
  vi.stubGlobal('fetch', mockApi(routes));
  const Probe = locationProbe();
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/create" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const emptyOrgs: RouteHandler = () => jsonResponse(200, { organizations: [] });
const orgsOne: RouteHandler = () =>
  jsonResponse(200, { organizations: [{ id: 'org-1', name: 'Acme', roleId: 'owner' }] });
const workflows: RouteHandler = () =>
  jsonResponse(200, {
    workflows: [
      {
        id: 'wf-1',
        organizationId: 'org-1',
        ownerUserId: 'u-1',
        slug: 'weekly-invoice-digest',
        name: 'Weekly invoice digest',
        description: 'Collect invoices and email the digest.',
        visibility: 'private',
        headVersionId: 'ver-1',
        forkedFromWorkflowId: null,
        forkedFromVersionId: null,
        createdAt: '2026-09-01T10:00:00Z',
        updatedAt: '2026-09-04T09:00:00Z',
      },
      {
        id: 'wf-2',
        organizationId: 'org-1',
        ownerUserId: 'u-1',
        slug: 'lead-followup',
        name: 'Lead follow-up',
        description: null,
        visibility: 'private',
        headVersionId: 'ver-2',
        forkedFromWorkflowId: null,
        forkedFromVersionId: null,
        createdAt: '2026-09-02T10:00:00Z',
        updatedAt: '2026-09-03T08:00:00Z',
      },
    ],
  });
const runs: RouteHandler = () =>
  jsonResponse(200, {
    runs: [
      {
        id: 'run-1',
        organizationId: 'org-1',
        workflowId: 'wf-1',
        versionId: 'ver-1',
        state: 'failed',
        createdAt: '2026-09-04T08:00:00Z',
        updatedAt: '2026-09-04T08:30:00Z',
      },
      {
        id: 'run-2',
        organizationId: 'org-1',
        workflowId: 'wf-1',
        versionId: 'ver-1',
        state: 'paused',
        createdAt: '2026-09-04T07:00:00Z',
        updatedAt: '2026-09-04T07:10:00Z',
      },
      {
        id: 'run-3',
        organizationId: 'org-1',
        workflowId: 'wf-2',
        versionId: 'ver-2',
        state: 'completed',
        createdAt: '2026-09-03T07:00:00Z',
        updatedAt: '2026-09-03T09:00:00Z',
      },
      {
        id: 'run-4',
        organizationId: 'org-1',
        workflowId: 'wf-2',
        versionId: 'ver-2',
        state: 'running',
        createdAt: '2026-09-04T09:00:00Z',
        updatedAt: '2026-09-04T09:05:00Z',
      },
    ],
  });

describe('V2-017 T2 — workflow-first Home', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockApi({ '/organizations': emptyOrgs }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('primary goal/search/creation entry', () => {
    it('renders the goal heading with the search entry and the three entry modes', async () => {
      renderHome({ '/organizations': emptyOrgs });
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /What do you want to get done\?/i })).toBeInTheDocument(),
      );
      expect(screen.getByRole('search')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /goal or search/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Describe it' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show me' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Describe + show' })).toBeInTheDocument();
    });

    it('navigates each entry mode to Create with its mode parameter', async () => {
      renderHome({ '/organizations': emptyOrgs });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Show me' }));
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/create?mode=show'));
    });

    it('starts creation from a typed goal through the search entry', async () => {
      renderHome({ '/organizations': emptyOrgs });
      const user = userEvent.setup();
      await user.type(screen.getByRole('textbox', { name: /goal or search/i }), 'invoice processing');
      await user.click(screen.getByRole('button', { name: 'Start' }));
      await waitFor(() => {
        const probe = screen.getByTestId('location');
        const params = new URLSearchParams(probe.textContent?.replace('/create?', '') ?? '');
        expect(probe.textContent).toContain('/create');
        expect(params.get('mode')).toBe('tell');
        expect(params.get('q')).toBe('invoice processing');
      });
    });
  });

  describe('recent workflows — explicit honest states', () => {
    it('shows a loading state while the read is in flight', async () => {
      let release!: (r: Response) => void;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      renderHome({ '/organizations': () => gate });
      expect(screen.getAllByRole('status', { name: /loading/i }).length).toBe(2);
      release(jsonResponse(200, { organizations: [] }));
      await waitFor(() =>
        expect(screen.queryAllByRole('status', { name: /loading/i }).length).toBe(0),
      );
    });

    it('renders a successful empty state (no organization ⇒ derivably no workflows)', async () => {
      renderHome({ '/organizations': emptyOrgs });
      const section = await screen.findByRole('region', { name: 'Recent workflows' });
      await waitFor(() => expect(within(section).getByText(/No workflows yet/i)).toBeInTheDocument());
      expect(within(section).queryByText(/Unavailable/i)).not.toBeInTheDocument();
      expect(within(section).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('renders real workflow records, most recent first, linking to the library', async () => {
      renderHome({
        '/workflow-repository/workflows': workflows,
        '/workflow-runs/runs': () => jsonResponse(200, { runs: [] }),
        '/organizations': orgsOne,
      });
      const section = await screen.findByRole('region', { name: 'Recent workflows' });
      const names = await within(section).findAllByRole('listitem');
      expect(names.map((n) => n.textContent)).toEqual([
        expect.stringMatching(/Weekly invoice digest/),
        expect.stringMatching(/Lead follow-up/),
      ]);
      expect(within(section).getByRole('link', { name: /see all/i })).toHaveAttribute('href', '/workflows');
      expect(within(section).queryByText(/No workflows yet/i)).not.toBeInTheDocument();
    });

    it('renders a visible error (never a fake empty) when the organization read fails', async () => {
      renderHome({ '/organizations': () => jsonResponse(500, { error: 'boom' }) });
      const section = await screen.findByRole('region', { name: 'Recent workflows' });
      await waitFor(() => expect(within(section).getByRole('alert')).toBeInTheDocument());
      expect(within(section).getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(within(section).queryByText(/No workflows yet/i)).not.toBeInTheDocument();
      expect(within(section).queryByText(/Unavailable/i)).not.toBeInTheDocument();
    });

    it('renders a visible error when the workflow read itself fails', async () => {
      renderHome({
        '/organizations': orgsOne,
        '/workflow-repository/workflows': () => jsonResponse(500, { error: 'boom' }),
      });
      const section = await screen.findByRole('region', { name: 'Recent workflows' });
      await waitFor(() => expect(within(section).getByRole('alert')).toBeInTheDocument());
      expect(within(section).queryByText(/No workflows yet/i)).not.toBeInTheDocument();
    });
  });

  describe('needs attention — derived from the run read', () => {
    it('lists failed and paused runs (not completed or running)', async () => {
      renderHome({
        '/workflow-repository/workflows': workflows,
        '/workflow-runs/runs': runs,
        '/organizations': orgsOne,
      });
      const section = await screen.findByRole('region', { name: 'Needs attention' });
      const items = await within(section).findAllByRole('listitem');
      expect(items.length).toBe(2);
      expect(within(items[0]).getByText('Failed')).toBeInTheDocument();
      expect(within(items[1]).getByText('Paused')).toBeInTheDocument();
      expect(within(section).getByRole('link', { name: /see all/i })).toHaveAttribute('href', '/activity');
    });

    it('renders the honest empty state when nothing needs attention', async () => {
      renderHome({
        '/workflow-repository/workflows': workflows,
        '/workflow-runs/runs': () => jsonResponse(200, { runs: [] }),
        '/organizations': orgsOne,
      });
      const section = await screen.findByRole('region', { name: 'Needs attention' });
      await waitFor(() =>
        expect(within(section).getByText(/Nothing needs your attention/i)).toBeInTheDocument(),
      );
      expect(within(section).queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('surfaces without an exposed read stay honestly Unavailable', () => {
    it('marks pending approvals, updates, and device issues Unavailable — never fake-empty', async () => {
      renderHome({
        '/workflow-repository/workflows': workflows,
        '/workflow-runs/runs': runs,
        '/organizations': orgsOne,
      });
      const approvals = await screen.findByRole('region', { name: 'Pending approvals' });
      const updates = await screen.findByRole('region', { name: 'Updates' });
      const devices = await screen.findByRole('region', { name: 'Device issues' });
      for (const section of [approvals, updates, devices]) {
        expect(within(section).getByRole('status', { name: 'Unavailable' })).toBeInTheDocument();
        expect(within(section).queryByText(/no items yet/i)).not.toBeInTheDocument();
        expect(within(section).queryByText(/nothing yet/i)).not.toBeInTheDocument();
      }
    });
  });
});

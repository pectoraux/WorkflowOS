/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import WorkflowDetailPage from './WorkflowDetailPage';

/**
 * V2-017 T4 — the workflow detail contract (Issue #190 dispatch).
 *
 * The detail page composes over EXISTING authorities: the V2-002 workflow
 * read, the version read (immutable versions), the V2-005 runs read, the
 * installations read, and the workflow-deployments reads. HONESTY RULES:
 *   - loading / error / data states explicitly; a failed read is never a
 *     successful empty;
 *   - steps derive ONLY from authoritative IR content (parsed
 *     presentation-side, never invented); non-IR content → honest
 *     Unavailable;
 *   - the primary actions (Run / Teach Me / Edit) are communicated; their
 *     deep flows belong to later tasks — Run/Teach Me carry honest
 *     arrives-with notes; Edit enters the EXISTING expert workspace;
 *   - the pinned installation version is shown verbatim; no update is
 *     implied before an authoritative action;
 *   - digests/internal IDs stay expert-only (never rendered).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    for (const [fragment, handler] of ordered) {
      if (url.includes(fragment)) return Promise.resolve(handler());
    }
    return Promise.resolve(jsonResponse(500, { error: `unmocked ${url}` }));
  });
}

const WORKFLOW = {
  id: 'wf-1',
  organizationId: 'org-1',
  ownerUserId: 'user-1',
  slug: 'weekly-invoice-digest',
  name: 'Weekly invoice digest',
  description: 'Collect invoices and email the digest.',
  visibility: 'private',
  headVersionId: 'ver-2',
  forkedFromWorkflowId: null,
  forkedFromVersionId: null,
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-04T09:00:00Z',
};

const IR_CONTENT = {
  objectType: 'workflowos/workflow-ir/v1',
  irSchemaVersion: 1,
  ir: {
    start: 'fetch_open_tickets',
    nodes: [
      {
        id: 'fetch_open_tickets',
        executionClass: 'deterministic_api',
        spec: { class: 'deterministic_api', capability: 'github.repository.read' },
        capabilityRequirements: ['github.repository.read'],
        placement: 'cloud_allowed',
      },
      {
        id: 'send_followup',
        executionClass: 'agentic_computer_use',
        spec: { class: 'agentic_computer_use', capability: 'messaging.send' },
        capabilityRequirements: ['messaging.send'],
        placement: 'cloud_allowed',
      },
    ],
    edges: [],
    defaultPlacement: 'cloud_allowed',
  },
};

const VERSIONS = [
  {
    id: 'ver-1',
    workflowId: 'wf-1',
    versionNumber: 1,
    contentDigest: 'sha256:old',
    content: IR_CONTENT,
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    parentVersionId: null,
    createdByUserId: 'user-1',
    createdAt: '2026-09-01T10:00:00Z',
  },
  {
    id: 'ver-2',
    workflowId: 'wf-1',
    versionNumber: 2,
    contentDigest: 'sha256:new',
    content: IR_CONTENT,
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    parentVersionId: 'ver-1',
    createdByUserId: 'user-1',
    createdAt: '2026-09-04T09:00:00Z',
  },
];

const RUNS = [
  {
    id: 'run-1',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    versionId: 'ver-2',
    state: 'failed',
    createdAt: '2026-09-04T08:00:00Z',
    updatedAt: '2026-09-04T08:30:00Z',
  },
  {
    id: 'run-2',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    versionId: 'ver-2',
    state: 'completed',
    createdAt: '2026-09-03T08:00:00Z',
    updatedAt: '2026-09-03T09:00:00Z',
  },
];

const INSTALLATIONS = [
  {
    installation: {
      id: 'inst-1',
      organizationId: 'org-1',
      workflowId: 'wf-1',
      versionId: 'ver-2',
      installedByUserId: 'user-1',
      status: 'enabled',
      installedAt: '2026-09-02T09:00:00Z',
      updatedAt: '2026-09-02T09:00:00Z',
    },
    pinnedVersion: {
      id: 'ver-2',
      workflowId: 'wf-1',
      versionNumber: 2,
      contentDigest: 'sha256:new',
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    },
  },
];

const DEPLOYMENTS = [
  {
    id: 'dep-1',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    versionId: 'ver-2',
    installationId: 'inst-1',
    name: 'Weekly invoice digest',
    description: null,
    placement: { placement: { required: 'cloud_allowed' }, privacy: { localOnly: false } },
    enabled: true,
    enabledAt: '2026-09-02T11:00:00Z',
    disabledAt: null,
    createdByUserId: 'user-1',
    createdAt: '2026-09-02T11:00:00Z',
    updatedAt: '2026-09-02T11:00:00Z',
  },
];

const SUBSCRIPTIONS = [
  {
    id: 'sub-1',
    organizationId: 'org-1',
    deploymentId: 'dep-1',
    kind: 'schedule',
    schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
    eventPattern: null,
    deliveryPolicy: { missedWindow: 'skip' },
    enabled: true,
    cursor: null,
    createdAt: '2026-09-02T11:00:00Z',
    updatedAt: '2026-09-02T11:00:00Z',
  },
];

function fullRoutes(overrides: Record<string, RouteHandler> = {}): Record<string, RouteHandler> {
  return {
    '/workflow-repository/workflows/wf-1/versions': () => jsonResponse(200, { versions: VERSIONS }),
    '/workflow-runs/runs': () => jsonResponse(200, { runs: RUNS }),
    '/workflow-repository/installations': () => jsonResponse(200, { installations: INSTALLATIONS }),
    '/workflow-deployments/deployments': () => jsonResponse(200, { deployments: DEPLOYMENTS }),
    '/workflow-deployments/deployments/dep-1/subscriptions': () =>
      jsonResponse(200, { subscriptions: SUBSCRIPTIONS }),
    '/workflow-repository/workflows/wf-1': () => jsonResponse(200, { workflow: WORKFLOW }),
    ...overrides,
  };
}

function renderDetail(workflowId: string, routes: Record<string, RouteHandler>) {
  vi.stubGlobal('fetch', mockApi(routes));
  return render(
    <MemoryRouter initialEntries={[`/workflows/${workflowId}`]}>
      <Routes>
        <Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
        <Route path="/expert" element={<div>Expert workspace</div>} />
        <Route path="/workflows" element={<div>Workflows library</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('V2-017 T4 — workflow detail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('communicates the purpose, primary actions, state, version, when/where, activity, access, and inspection entry', async () => {
    renderDetail('wf-1', fullRoutes());
    // Purpose.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Collect invoices and email the digest.')).toBeInTheDocument();
    // Primary actions (the row communicates Run / Teach Me / Edit).
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Teach Me' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toBeInTheDocument();
    // Attention state (run-derived: a failed run exists).
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    // Steps (derived from the authoritative IR content — never invented).
    const steps = screen.getByRole('list', { name: /what it does/i });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringMatching(/Fetch open tickets/i),
      expect.stringMatching(/Send followup/i),
    ]);
    // When it runs (subscription) and where (placement).
    expect(screen.getByText('Runs daily')).toBeInTheDocument();
    expect(screen.getByText('Cloud')).toBeInTheDocument();
    // Recent activity (the authoritative runs, most recent first).
    const activity = screen.getByRole('list', { name: /recent activity/i });
    const items = within(activity).getAllByRole('listitem');
    expect(items.length).toBe(2);
    expect(within(items[0]).getByText('failed')).toBeInTheDocument();
    // Version facts: the head version is immutable; the installed pin is
    // shown verbatim (never implying an update).
    expect(screen.getByText('Version 2 — immutable')).toBeInTheDocument();
    expect(screen.getByText(/Installed: Version 2 — pinned · Enabled/)).toBeInTheDocument();
    // Access ("Needs access to" — capabilities from the IR).
    expect(screen.getByText(/Needs access to/i)).toBeInTheDocument();
    expect(screen.getByText(/github\.repository\.read/i)).toBeInTheDocument();
    expect(screen.getByText(/messaging\.send/i)).toBeInTheDocument();
    // Safety/visibility vocabulary.
    expect(screen.getByText(/Private — only you/i)).toBeInTheDocument();
    // Advanced inspection entry (the existing expert workspace).
    expect(screen.getByRole('link', { name: /inspect in the expert workspace/i })).toHaveAttribute(
      'href',
      '/expert',
    );
    // Internal digests NEVER render.
    expect(screen.queryByText(/sha256/i)).not.toBeInTheDocument();
  });

  it('shows a loading state while the reads are in flight', async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    renderDetail('wf-1', {
      '/workflow-repository/workflows/wf-1': () => gate,
      '/workflow-repository/workflows/wf-1/versions': () =>
        jsonResponse(200, { versions: VERSIONS }),
      '/workflow-runs/runs': () => jsonResponse(200, { runs: [] }),
      '/workflow-repository/installations': () => jsonResponse(200, { installations: [] }),
      '/workflow-deployments/deployments': () => jsonResponse(200, { deployments: [] }),
    });
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    release(jsonResponse(200, { workflow: WORKFLOW }));
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument(),
    );
  });

  it('renders a visible error (never empty) when the workflow read fails', async () => {
    renderDetail('wf-1', fullRoutes({
      '/workflow-repository/workflows/wf-1': () => jsonResponse(404, { error: 'workflow-not-found' }),
    }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Weekly invoice digest' })).not.toBeInTheDocument();
  });

  it('shows the honest steps-unavailable state when the version content is not WorkflowIR', async () => {
    renderDetail(
      'wf-1',
      fullRoutes({
        '/workflow-repository/workflows/wf-1/versions': () =>
          jsonResponse(200, {
            versions: [{ ...VERSIONS[1], content: { someOpaque: 'not-ir' } }],
          }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/steps aren't available in a human-readable form yet/i),
    ).toBeInTheDocument();
    // No invented steps.
    expect(screen.queryByRole('list', { name: /what it does/i })).not.toBeInTheDocument();
  });

  it('Run and Teach Me carry honest arrives-with states (no fabricated flows); Edit enters the expert workspace', async () => {
    renderDetail('wf-1', fullRoutes());
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText(/run experience arrives with the run task/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Teach Me' }));
    expect(screen.getByText(/teaching experience arrives with the teaching task/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/expert');
  });

  it('when no subscription exists the honest manual fact renders; no deployment → honest no-where fact', async () => {
    renderDetail(
      'wf-1',
      fullRoutes({
        '/workflow-deployments/deployments': () => jsonResponse(200, { deployments: [] }),
        '/workflow-repository/installations': () => jsonResponse(200, { installations: [] }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Runs when started manually')).toBeInTheDocument();
    expect(screen.getByText(/not deployed yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No installs/i)).toBeInTheDocument();
  });
});

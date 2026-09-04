/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CreatePage from './CreatePage';

/**
 * V2-017 T2 — the creation entry-point landing contract.
 *
 * The Home entry buttons and the search box navigate to /create carrying
 * the chosen entry mode (tell / show / tell-show) and the typed goal (q).
 * CreatePage receives them: the matching entry mode is marked active and
 * the goal is shown as the starting context. Without parameters the page
 * stays neutral — no fabricated selection or goal.
 */

function renderCreate(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/create${search}`]}>
      <CreatePage />
    </MemoryRouter>,
  );
}

describe('V2-017 T2 — Create entry-point landing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks the Show entry mode active and shows the typed goal', () => {
    renderCreate('?mode=show&q=invoice%20processing');
    const modes = screen.getByRole('list', { name: /creation entry modes/i });
    expect(within(modes).getByText('Show').closest('li')?.getAttribute('aria-current')).toBe('true');
    expect(within(modes).getByText('Tell').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(within(modes).getByText('Tell + Show').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(screen.getByText(/invoice processing/i)).toBeInTheDocument();
  });

  it('marks the Tell + Show entry mode active for mode=tell-show', () => {
    renderCreate('?mode=tell-show');
    const modes = screen.getByRole('list', { name: /creation entry modes/i });
    expect(within(modes).getByText('Tell + Show').closest('li')?.getAttribute('aria-current')).toBe('true');
  });

  it('stays neutral without mode or goal parameters', () => {
    renderCreate('');
    const modes = screen.getByRole('list', { name: /creation entry modes/i });
    expect(within(modes).getByText('Show').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(within(modes).getByText('Tell').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(within(modes).getByText('Tell + Show').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(screen.queryByText(/your goal/i)).not.toBeInTheDocument();
  });
});

/**
 * V2-017 T5 — the Tell / Show / Tell + Show creation contract.
 *
 * Creation starts from the goal (UX spec §7): the entry mode lands from T2;
 * T5 owns the capture → understanding preview → correction → EXPLICIT
 * COMMIT flow, composed over the existing V2-002 authoring route.
 *
 * HONESTY RULES:
 *   - the preview shows exactly what the user told/showed (verbatim) plus
 *     the structured fields they can CORRECT — it never INVENTS understood
 *     steps/capabilities (surfacing the honest limitation instead);
 *   - the captured input is transient client-local state, never durable
 *     workflow truth: nothing renders as created before the authoritative
 *     POST succeeds, and the success surface renders FROM THE RESPONSE;
 *   - the durable creation goes through the existing V2-002 create route
 *     with the captured input as the version-1 content and an HONEST
 *     protocol descriptor (captured-input, never claiming WorkflowIR
 *     compatibility); immutable-version semantics are surfaced verbatim;
 *   - a failed commit stays a visible error (never a silent success), and
 *     the create-or-converge result is shown honestly (created flag);
 *   - with no organization, the honest missing-information state appears —
 *     no commit is possible, nothing is fabricated.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  // Longest fragment first: the org-scoped create URL must match its own
  // handler, never the bare '/organizations' one.
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    for (const [fragment, handler] of ordered) {
      if (url.includes(fragment)) return Promise.resolve(handler(input, init));
    }
    return Promise.resolve(jsonResponse(500, { error: `unmocked ${url}` }));
  });
}

const orgsOne = () =>
  jsonResponse(200, {
    organizations: [{ id: 'org-1', name: 'Acme', roleId: 'owner' }],
  });
const orgsNone = () => jsonResponse(200, { organizations: [] });
const orgsTwo = () =>
  jsonResponse(200, {
    organizations: [
      { id: 'org-1', name: 'Acme', roleId: 'owner' },
      { id: 'org-2', name: 'Globex', roleId: 'owner' },
    ],
  });

const createdWorkflow = (name: string) => ({
  workflow: {
    id: 'wf-new',
    organizationId: 'org-1',
    ownerUserId: 'user-1',
    slug: 'weekly-invoice-digest',
    name,
    description: 'Collect invoices and email the digest.',
    visibility: 'private',
    headVersionId: 'ver-1',
    forkedFromWorkflowId: null,
    forkedFromVersionId: null,
    createdAt: '2026-09-04T10:00:00Z',
    updatedAt: '2026-09-04T10:00:00Z',
  },
  initialVersion: {
    id: 'ver-1',
    workflowId: 'wf-new',
    versionNumber: 1,
    contentDigest: 'sha256:abc',
    content: {},
    protocol: { irSchemaVersion: 'workflowos-captured-input-v1' },
    parentVersionId: null,
    createdByUserId: 'user-1',
    createdAt: '2026-09-04T10:00:00Z',
  },
  created: true,
});

function renderCreateFlow(search: string, routes: Record<string, RouteHandler>) {
  vi.stubGlobal('fetch', mockApi(routes));
  return render(
    <MemoryRouter initialEntries={[`/create${search}`]}>
      <CreatePage />
    </MemoryRouter>,
  );
}

async function reachPreview(
  routes: Record<string, RouteHandler>,
  options: { mode?: string; goal?: string; steps?: string[] } = {},
) {
  const { mode = 'tell', goal = '', steps = [] } = options;
  const search = `?mode=${mode}${goal ? `&q=${encodeURIComponent(goal)}` : ''}`;
  renderCreateFlow(search, routes);
  const user = userEvent.setup();
  if (mode === 'tell' || mode === 'tell-show') {
    const box = await screen.findByRole('textbox', { name: /describe what you want done/i });
    if (goal) {
      // The typed goal pre-fills the Tell capture.
      expect(box).toHaveValue(goal);
    } else {
      await user.type(box, 'Send the weekly invoice digest');
    }
  }
  if (mode === 'show' || mode === 'tell-show') {
    for (const step of steps.length > 0 ? steps : ['Open the sales dashboard', 'Export the report']) {
      await user.type(
        screen.getByRole('textbox', { name: /describe one step/i }),
        step,
      );
      await user.click(screen.getByRole('button', { name: 'Add step' }));
    }
  }
  await user.click(screen.getByRole('button', { name: 'Continue to preview' }));
  await screen.findByRole('heading', { name: /here's what i understood/i });
  return user;
}

describe('V2-017 T5 — Tell / Show / Tell + Show creation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Tell: capture → understanding preview shows the description verbatim and NO invented steps', async () => {
    await reachPreview({ '/organizations': orgsOne });
    // The description the user gave is echoed back for correction.
    const echo = within(screen.getByRole('region', { name: 'Captured input' }));
    expect(echo.getByText(/Send the weekly invoice digest/i)).toBeInTheDocument();
    // The honest limitation is surfaced, not fabricated understanding.
    expect(
      screen.getByText(/can't yet turn your description into executable steps/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/starting content/i)).toBeInTheDocument();
    // Correction fields exist: the structured facts the user owns.
    expect(screen.getByRole('textbox', { name: /workflow name/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /workflow slug/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /visibility/i })).toBeInTheDocument();
    // Transient state is not durable truth: nothing renders as created yet.
    expect(screen.queryByText(/workflow created/i)).not.toBeInTheDocument();
  });

  it('Show: demonstration steps appear numbered in the preview', async () => {
    await reachPreview(
      { '/organizations': orgsOne },
      { mode: 'show', steps: ['Open the sales dashboard', 'Export the report', 'Rename the file'] },
    );
    const steps = screen.getByRole('list', { name: /your demonstration/i });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Open the sales dashboard',
      'Export the report',
      'Rename the file',
    ]);
    // The honest provenance note (UX spec §7: captures are never the durable
    // workflow itself).
    expect(screen.getByText(/recorded as the starting content/i)).toBeInTheDocument();
  });

  it('Tell + Show: the preview shows both the description and the steps', async () => {
    await reachPreview(
      { '/organizations': orgsOne },
      { mode: 'tell-show', goal: 'Send the weekly invoice digest', steps: ['Collect the invoices'] },
    );
    const echo = within(screen.getByRole('region', { name: 'Captured input' }));
    expect(echo.getByText(/Send the weekly invoice digest/i)).toBeInTheDocument();
    expect(echo.getByText('Collect the invoices')).toBeInTheDocument();
  });

  it('Change something returns to the capture with the input preserved', async () => {
    const user = await reachPreview({ '/organizations': orgsOne });
    await user.click(screen.getByRole('button', { name: 'Change something' }));
    expect(
      await screen.findByRole('textbox', { name: /describe what you want done/i }),
    ).toHaveValue('Send the weekly invoice digest');
    expect(screen.queryByRole('heading', { name: /here's what i understood/i })).not.toBeInTheDocument();
  });

  it('explicit commit creates through the V2-002 route with the honest captured-input payload', async () => {
    const routes: Record<string, RouteHandler> = {
      '/organizations': orgsOne,
      '/organizations/org-1/workflow-repository/workflows': (_input, init) => {
        expect(init?.method).toBe('POST');
        return jsonResponse(201, createdWorkflow('Weekly invoice digest'));
      },
    };
    const user = await reachPreview(routes);
    await user.clear(screen.getByRole('textbox', { name: /workflow name/i }));
    await user.type(screen.getByRole('textbox', { name: /workflow name/i }), 'Weekly invoice digest');
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    await screen.findByText(/workflow created/i);
    // The success surface renders FROM THE RESPONSE: the authoritative name
    // and the immutable initial version.
    expect(screen.getByText('Weekly invoice digest')).toBeInTheDocument();
    expect(screen.getByText(/version 1/i)).toBeInTheDocument();
    expect(screen.getByText(/immutable/i)).toBeInTheDocument();
    // The honest payload: captured input as content, the honest descriptor.
    const fetchMock = vi.mocked(fetch);
    const createCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/organizations/org-1/workflow-repository/workflows'),
    );
    expect(createCall).toBeDefined();
    const payload = JSON.parse(String(createCall?.[1]?.body)) as {
      name: string;
      slug: string;
      visibility: string;
      content: { goal?: string; steps?: string[] };
      protocol: { irSchemaVersion: string };
    };
    expect(payload.name).toBe('Weekly invoice digest');
    expect(payload.slug).toMatch(/^[a-z0-9]/);
    expect(payload.visibility).toBe('private');
    expect(payload.content.goal).toBe('Send the weekly invoice digest');
    expect(payload.protocol.irSchemaVersion).toBe('workflowos-captured-input-v1');
  });

  it('a converged create (created=false) is shown honestly — never a fabricated fresh creation', async () => {
    const converged = createdWorkflow('Weekly invoice digest');
    converged.created = false;
    const routes: Record<string, RouteHandler> = {
      '/organizations': orgsOne,
      '/organizations/org-1/workflow-repository/workflows': () =>
        jsonResponse(200, converged),
    };
    const user = await reachPreview(routes);
    await user.clear(screen.getByRole('textbox', { name: /workflow name/i }));
    await user.type(screen.getByRole('textbox', { name: /workflow name/i }), 'Weekly invoice digest');
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    await waitFor(() => expect(screen.getByText(/already existed/i)).toBeInTheDocument());
    expect(screen.getByText(/converged/i)).toBeInTheDocument();
  });

  it('a failed commit stays a visible error with retry — never a silent success', async () => {
    const routes: Record<string, RouteHandler> = {
      '/organizations': orgsOne,
      '/organizations/org-1/workflow-repository/workflows': () =>
        jsonResponse(400, { error: 'workflow-invalid-slug', message: 'slug must be 1-64 lowercase alphanumeric characters' }),
    };
    const user = await reachPreview(routes);
    await user.clear(screen.getByRole('textbox', { name: /workflow name/i }));
    await user.type(screen.getByRole('textbox', { name: /workflow name/i }), 'Weekly invoice digest');
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/workflow created/i)).not.toBeInTheDocument();
  });

  it('with no organization the honest missing-information state appears and no commit is possible', async () => {
    renderCreateFlow('?mode=tell', { '/organizations': orgsNone });
    await waitFor(() => expect(screen.getByText(/No organization yet/i)).toBeInTheDocument());
    const user = userEvent.setup();
    await user.type(
      screen.getByRole('textbox', { name: /describe what you want done/i }),
      'Send the weekly invoice digest',
    );
    await user.click(screen.getByRole('button', { name: 'Continue to preview' }));
    await screen.findByRole('heading', { name: /here's what i understood/i });
    const commit = screen.getByRole('button', { name: 'Create workflow' });
    expect(commit).toBeDisabled();
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/workflow-repository/workflows'),
      expect.anything(),
    );
  });

  it('with multiple organizations the user selects the creation target from the authoritative read', async () => {
    const routes: Record<string, RouteHandler> = {
      '/organizations': orgsTwo,
      '/organizations/org-2/workflow-repository/workflows': (_input, init) => {
        expect(init?.method).toBe('POST');
        return jsonResponse(201, createdWorkflow('Weekly invoice digest'));
      },
    };
    const user = await reachPreview(routes);
    const orgSelect = screen.getByRole('combobox', { name: /organization/i });
    await user.selectOptions(orgSelect, 'org-2');
    await user.clear(screen.getByRole('textbox', { name: /workflow name/i }));
    await user.type(screen.getByRole('textbox', { name: /workflow name/i }), 'Weekly invoice digest');
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    await screen.findByText(/workflow created/i);
    const fetchMock = vi.mocked(fetch);
    const createCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/organizations/org-2/workflow-repository/workflows'),
    );
    expect(createCall).toBeDefined();
  });
});

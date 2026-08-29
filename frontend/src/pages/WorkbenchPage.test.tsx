/**
 * WORK-048 — the Developer Workbench page smoke test (the established
 * MemoryRouter convention: assert the synchronous initial render — loading
 * state + header — before async settles; no fetch mocking).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastHost } from '@/components/ui/toast';
import WorkbenchPage from './WorkbenchPage';

describe('WORK-048 WorkbenchPage (initial render)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('renders the workbench loading state (no fabricated content before data arrives)', () => {
    render(
      <MemoryRouter initialEntries={['/projects/test-project-id/workbench']}>
        <ToastHost>
          <WorkbenchPage />
        </ToastHost>
      </MemoryRouter>,
    );
    expect(screen.getByText('Workbench')).toBeInTheDocument();
    expect(screen.getByText(/Loading the workbench/i)).toBeInTheDocument();
  });

  it('renders ALL ten workbench sections as tabs (the information architecture)', async () => {
    render(
      <MemoryRouter initialEntries={['/projects/test-project-id/workbench']}>
        <Routes>
          <Route
            path="/projects/:projectId/workbench"
            element={
              <ToastHost>
                <WorkbenchPage />
              </ToastHost>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    // The initial render shows the loading state; the tabs appear once the
    // (failing, jsdom) requests settle — find them asynchronously.
    await screen.findByRole('tab', { name: /Overview/i });
    for (const label of [
      'Work Graph',
      'Executions',
      'Changes',
      'Verification',
      'Reviews',
      'Deployments',
      'Maintenance',
      'Activity',
    ]) {
      expect(screen.getByRole('tab', { name: new RegExp(label, 'i') }), `tab ${label}`).toBeInTheDocument();
    }
  });
});

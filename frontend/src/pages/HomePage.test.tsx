import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import HomePage from './HomePage';

describe('V2-017 T2 — workflow-first Home', () => {
  it('starts from the goal with Describe, Show, and Describe + show entry modes', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <HomePage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /What do you want to get done\?/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Describe it/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show me/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Describe \+ show/i })).toBeInTheDocument();
  });

  it('shows the workflow-first attention surfaces without inventing records', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <HomePage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /Recent workflows/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Needs attention/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Pending approvals/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Updates/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Device issues/i })).toBeInTheDocument();
  });
});

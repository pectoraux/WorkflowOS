import { Activity, Code2, Compass, Home, ListChecks, Menu, Plus } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

const NAV = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/workflows', label: 'Workflows', icon: ListChecks },
  { to: '/explore', label: 'Explore', icon: Compass },
  { to: '/activity', label: 'Activity', icon: Activity },
];

export default function UniversalProductShell({ children }: { children: ReactNode }) {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur">
        <div className="mx-auto flex min-h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2" aria-label="WorkflowOS home">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Activity className="h-4 w-4" />
            </div>
            <span className="font-semibold tracking-tight">WorkflowOS</span>
          </Link>

          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Primary">
            {NAV.map(({ to, label, icon: Icon }) => {
              const active = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
              return (
                <Link
                  key={to}
                  to={to}
                  aria-current={active ? 'page' : undefined}
                  className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                    active
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                </Link>
              );
            })}
          </nav>

          <Link
            to="/create"
            className="flex shrink-0 items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Create</span>
            <span className="sm:hidden" aria-hidden="true">+</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 text-xs text-muted-foreground sm:px-6">
          <span>WorkflowOS keeps authoritative state in the backend.</span>
          <Link to="/expert" className="inline-flex items-center gap-1.5 hover:text-foreground">
            <Code2 className="h-3.5 w-3.5" />
            Expert workspace
          </Link>
        </div>
      </footer>
    </div>
  );
}

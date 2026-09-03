import UniversalProductShell from '@/components/shell/UniversalProductShell';

export default function WorkflowsPage() {
  return (
    <UniversalProductShell>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Do</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Workflows</h1>
          <p className="mt-2 text-muted-foreground">Your installed, shared, draft, and archived workflows live here.</p>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Workflow views">
          {['My Workflows', 'Installed', 'Shared', 'Drafts', 'Archived'].map((label) => (
            <button key={label} type="button" className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-accent">
              {label}
            </button>
          ))}
        </div>
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <h2 className="font-medium">Your workflow library is ready</h2>
          <p className="mt-2 text-sm text-muted-foreground">Workflow records will be presented here using authoritative backend reads in the next task.</p>
        </div>
      </div>
    </UniversalProductShell>
  );
}

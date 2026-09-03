import { Link } from 'react-router-dom';
import UniversalProductShell from '@/components/shell/UniversalProductShell';

export default function CreatePage() {
  return (
    <UniversalProductShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Make</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Create a workflow</h1>
          <p className="mt-2 text-muted-foreground">Tell WorkflowOS what you want to accomplish. Authoring will stay grounded in the existing workflow contracts.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {['Tell', 'Show', 'Tell + Show'].map((mode) => (
            <button key={mode} type="button" className="rounded-xl border border-border bg-card p-5 text-left hover:bg-accent/40">
              <span className="font-medium">{mode}</span>
              <span className="mt-2 block text-sm text-muted-foreground">Start from {mode.toLowerCase()} input.</span>
            </button>
          ))}
        </div>
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-medium">Understanding before commitment</h2>
          <p className="mt-2 text-sm text-muted-foreground">The creation flow will show its understanding and allow correction before any durable workflow change is committed.</p>
        </div>
        <Link className="inline-flex rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent" to="/workflows">
          Back to workflows
        </Link>
      </div>
    </UniversalProductShell>
  );
}

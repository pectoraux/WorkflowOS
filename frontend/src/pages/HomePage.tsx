import { Link } from 'react-router-dom';
import UniversalProductShell from '@/components/shell/UniversalProductShell';

export default function HomePage() {
  return (
    <UniversalProductShell>
      <div className="space-y-8">
        <section className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-10">
          <p className="text-sm font-medium text-muted-foreground">Make • Do • Learn • Share • Improve</p>
          <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
            What do you want to get done?
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Start with something you need to accomplish. WorkflowOS will keep the workflow and its authoritative state behind the scenes.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90" to="/create">
              Create a workflow
            </Link>
            <Link className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent" to="/workflows">
              See my workflows
            </Link>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3" aria-label="Next steps">
          <Link to="/workflows" className="rounded-xl border border-border bg-card p-5 hover:bg-accent/40">
            <h2 className="font-medium">Recent workflows</h2>
            <p className="mt-2 text-sm text-muted-foreground">Pick up something you already use.</p>
          </Link>
          <Link to="/activity" className="rounded-xl border border-border bg-card p-5 hover:bg-accent/40">
            <h2 className="font-medium">What needs attention?</h2>
            <p className="mt-2 text-sm text-muted-foreground">Review recent runs, approvals, and updates.</p>
          </Link>
          <Link to="/explore" className="rounded-xl border border-border bg-card p-5 hover:bg-accent/40">
            <h2 className="font-medium">Explore</h2>
            <p className="mt-2 text-sm text-muted-foreground">Discover workflows you can install or make your own.</p>
          </Link>
        </section>
      </div>
    </UniversalProductShell>
  );
}

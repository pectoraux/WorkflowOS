import UniversalProductShell from '@/components/shell/UniversalProductShell';

export default function ExplorePage() {
  return (
    <UniversalProductShell>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Share</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Explore</h1>
          <p className="mt-2 text-muted-foreground">Find workflows published for you to install, inspect, or make your own.</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <h2 className="font-medium">Workflow catalog</h2>
          <p className="mt-2 text-sm text-muted-foreground">Marketplace listings and installation actions will be composed over their existing authorities in later tasks.</p>
        </div>
      </div>
    </UniversalProductShell>
  );
}

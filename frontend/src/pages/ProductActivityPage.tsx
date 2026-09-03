import UniversalProductShell from '@/components/shell/UniversalProductShell';

export default function ProductActivityPage() {
  return (
    <UniversalProductShell>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Understand</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Activity</h1>
          <p className="mt-2 text-muted-foreground">See runs, approvals, updates, and other workflow activity as it becomes available.</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <h2 className="font-medium">Nothing to review yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">Activity records will distinguish completed work, failures, and unavailable reads instead of treating them as empty data.</p>
        </div>
      </div>
    </UniversalProductShell>
  );
}

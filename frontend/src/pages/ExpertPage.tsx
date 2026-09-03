import { Link } from 'react-router-dom';
import UniversalProductShell from '@/components/shell/UniversalProductShell';

export default function ExpertPage() {
  return (
    <UniversalProductShell>
      <div className="max-w-3xl space-y-6">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Inspect • Control</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Expert workspace</h1>
          <p className="mt-2 text-muted-foreground">Engineering and architecture controls remain available as a deeper workspace rather than the default product experience.</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-medium">Developer workspace</h2>
          <p className="mt-2 text-sm text-muted-foreground">Choose a project to reach the existing workbench, architecture, requirements, and other engineering controls.</p>
          <Link
            to="/projects"
            className="mt-5 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open developer workspace
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">The expert surface remains a consumer of the existing backend authorities; it does not introduce a second workflow or execution authority.</p>
      </div>
    </UniversalProductShell>
  );
}

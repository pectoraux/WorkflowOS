import { useNavigate } from 'react-router-dom';

const ATTENTION_SURFACES = [
  {
    title: 'Recent workflows',
    description: 'Your latest workflow activity will appear here when the authoritative workflow read is available.',
  },
  {
    title: 'Needs attention',
    description: 'Items requiring a decision or intervention will appear here when the authoritative read is available.',
  },
  {
    title: 'Pending approvals',
    description: 'Approval requests will appear here when the authoritative approval read is available.',
  },
  {
    title: 'Updates',
    description: 'Version and product updates will appear here when the authoritative update read is available.',
  },
  {
    title: 'Device issues',
    description: 'Unsupported or unavailable device capabilities will appear here when the authoritative device read is available.',
  },
] as const;

function UnavailableSurface({ title, description }: (typeof ATTENTION_SURFACES)[number]) {
  return (
    <section className="rounded-xl border border-border bg-card p-5" aria-label={title}>
      <h2 className="font-medium">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground" role="status">
        Unavailable
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </section>
  );
}

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-10">
        <p className="text-sm font-medium text-muted-foreground">Make · Do · Learn · Share · Improve</p>
        <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          What do you want to get done?
        </h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Start with a goal. Choose the way you want to describe or demonstrate it, then let WorkflowOS carry the durable workflow state.
        </p>
        <div className="mt-6 flex flex-wrap gap-3" aria-label="Create options">
          <button
            type="button"
            onClick={() => navigate('/create?mode=describe')}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Describe it
          </button>
          <button
            type="button"
            onClick={() => navigate('/create?mode=show')}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Show me
          </button>
          <button
            type="button"
            onClick={() => navigate('/create?mode=describe-show')}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Describe + show
          </button>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2" aria-label="Home attention surfaces">
        {ATTENTION_SURFACES.map((surface) => (
          <UnavailableSurface key={surface.title} {...surface} />
        ))}
      </section>
    </div>
  );
}

/**
 * WORK-048 — the Developer Workbench: the primary human-facing engineering
 * workspace.
 *
 * ARCHITECTURE (non-negotiable): this page is a CONSUMER of backend
 * authorities. Every rendered value comes from a backend API response —
 * the work graph (nodes + edges + unsatisfied dependencies + workflow
 * states from the WORK-048 read model), the rollups (executions, changes,
 * verification runs, reviews), the runtime/deployment authority, the
 * maintenance/planning authorities, and the audit activity feed. This page:
 *
 *   - performs ZERO mutations (no POST/PATCH calls — read-only surface);
 *   - owns NO workflow/authorization/execution/verification/review state;
 *   - renders missing data as explicitly unavailable (never invented);
 *   - renders failed requests as errors (never fabricated success);
 *   - re-derives everything from fresh responses on every refresh (stale UI
 *     state can never override server truth).
 */
import * as React from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  RefreshCw,
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowRight,
  CircleCheckBig,
  Cpu,
  GitPullRequest,
  Layers,
  ListChecks,
  Rocket,
  ShieldCheck,
  Stethoscope,
  Users,
} from 'lucide-react';
import {
  audit,
  architecture,
  maintenance,
  planning,
  projects as projectsApi,
  runtime as runtimeApi,
  workflow as workflowApi,
  workbench as workbenchApi,
  type AuditEvent,
  type Deployment,
  type ExecutionSummary,
  type MaintenanceHealth,
  type PlanningRecommendationItem,
  type PrAssociation,
  type Project,
  type ProjectRuntimeStatus,
  type Review,
  type VerificationRun,
  type WorkGraph,
  type WorkGraphNode,
} from '@/api/client';
import { PageHeader } from '@/components/domain/page-header';
import { LoadingState } from '@/components/domain/loading-state';
import { ErrorState } from '@/components/domain/error-state';
import { EmptyState } from '@/components/domain/empty-state';
import { StatusBadge } from '@/components/domain/status-badge';
import { AuditEventItem } from '@/components/domain/audit-event-item';
import { WorkGraphBoard } from '@/components/workbench/work-graph-board';
import { countByState, deriveAttention } from '@/lib/work-graph';
import { formatRelative, shortId, titleCase } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

const TABS = [
  { value: 'overview', label: 'Overview', icon: Layers },
  { value: 'graph', label: 'Work Graph', icon: ListChecks },
  { value: 'work', label: 'Work', icon: Layers },
  { value: 'executions', label: 'Executions', icon: Cpu },
  { value: 'changes', label: 'Changes', icon: GitPullRequest },
  { value: 'verification', label: 'Verification', icon: ShieldCheck },
  { value: 'reviews', label: 'Reviews', icon: Users },
  { value: 'deployments', label: 'Deployments', icon: Rocket },
  { value: 'maintenance', label: 'Maintenance', icon: Stethoscope },
  { value: 'activity', label: 'Activity', icon: ActivityIcon },
] as const;

type TabValue = (typeof TABS)[number]['value'];

/** A one-line rollup row (icon + content), linked to the authoritative page. */
function RowCard({
  to,
  title,
  meta,
  badge,
}: {
  to?: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  const inner = (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="truncate text-sm font-medium text-foreground">{title}</div>
        {meta && <div className="truncate text-xs text-muted-foreground">{meta}</div>}
      </div>
      {badge}
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}

function HealthChip({ label, status }: { label: string; status?: string }) {
  const tone =
    status === 'connected' || status === 'ready'
      ? 'success'
      : status === 'error'
        ? 'destructive'
        : 'secondary';
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {status !== undefined ? (
        <Badge variant={tone as 'success' | 'destructive' | 'secondary'}>{titleCase(status)}</Badge>
      ) : (
        <span className="text-xs text-muted-foreground">Unknown</span>
      )}
    </div>
  );
}

export default function WorkbenchPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as TabValue | null;
  const tab: TabValue = tabParam && TABS.some((t) => t.value === tabParam) ? tabParam : 'overview';

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshingAt, setRefreshingAt] = React.useState<number | null>(null);

  // Authoritative reads (never mutated here).
  const [project, setProject] = React.useState<Project | null>(null);
  const [graph, setGraph] = React.useState<WorkGraph | null>(null);
  const [runtimeStatus, setRuntimeStatus] = React.useState<ProjectRuntimeStatus | null>(null);
  const [executions, setExecutions] = React.useState<ExecutionSummary[]>([]);
  const [prAssociations, setPrAssociations] = React.useState<PrAssociation[]>([]);
  const [verificationRuns, setVerificationRuns] = React.useState<VerificationRun[]>([]);
  const [reviews, setReviews] = React.useState<Review[]>([]);
  const [deployments, setDeployments] = React.useState<Deployment[]>([]);
  const [auditEvents, setAuditEvents] = React.useState<AuditEvent[]>([]);
  const [nextWorkItemId, setNextWorkItemId] = React.useState<string | null>(null);
  const [planningRecs, setPlanningRecs] = React.useState<PlanningRecommendationItem[]>([]);
  const [maintenanceHealth, setMaintenanceHealth] = React.useState<MaintenanceHealth | null>(null);
  const [advisoryNote, setAdvisoryNote] = React.useState<string | null>(null);

  const nodeById = React.useMemo(() => {
    const m = new Map<string, WorkGraphNode>();
    if (graph) for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  const loadAll = React.useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    setAdvisoryNote(null);

    // The version walk (the WorkItemsPage convention: first architecture →
    // frozen version, falling back to the first) feeds the maintenance +
    // planning reads, which are version-scoped by their authorities.
    const versionWalk = architecture
      .listForProject(projectId)
      .then(async (archs) => {
        if (archs.length === 0) return null;
        const versions = await architecture.listVersions(archs[0]!.id);
        const frozen = versions.find((v) => v.state === 'frozen') ?? versions[0];
        return frozen ?? null;
      })
      .catch(() => null);

    Promise.all([
      projectsApi.get(projectId).catch(() => null),
      workbenchApi.getWorkGraph(projectId).catch(() => null),
      runtimeApi.getStatus(projectId).catch(() => null),
      workbenchApi.listExecutions(projectId, 50).catch(() => []),
      workbenchApi.listPrAssociations(projectId, 50).catch(() => []),
      workbenchApi.listVerificationRuns(projectId, 50).catch(() => []),
      workbenchApi.listReviews(projectId, 50).catch(() => []),
      runtimeApi.listDeployments(projectId).catch(() => []),
      audit.listForProject(projectId, { limit: 25 }).catch(() => []),
    ])
      .then(
        ([
          p,
          g,
          rs,
          ex,
          prs,
          runs,
          revs,
          deps,
          events,
        ]) => {
          setProject(p);
          setGraph(g);
          setRuntimeStatus(rs);
          setExecutions(ex);
          setPrAssociations(prs);
          setVerificationRuns(runs);
          setReviews(revs);
          setDeployments(deps);
          setAuditEvents(events);
          setRefreshingAt(Date.now());
          if (g === null) {
            setAdvisoryNote('The work graph is unavailable for this project.');
          }
        },
      )
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load the workbench'))
      .finally(() => setLoading(false));

    // The next work item (the workflow authority's own selection).
    workflowApi
      .getNextWorkItem(projectId)
      .then((r) => setNextWorkItemId(r.nextWorkItemId))
      .catch(() => setNextWorkItemId(null));

    // Planning + maintenance (version-scoped authorities).
    versionWalk.then((version) => {
      if (!version) {
        setPlanningRecs([]);
        setMaintenanceHealth(null);
        return;
      }
      planning
        .listRecommendations(projectId, version.id)
        .then((recs) => setPlanningRecs(recs.filter((r) => !r.completed).slice(0, 5)))
        .catch(() => setPlanningRecs([]));
      maintenance
        .getHealth(projectId, version.id)
        .then((h) => setMaintenanceHealth(h))
        .catch(() => setMaintenanceHealth(null));
    });
  }, [projectId]);

  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

  const attention = React.useMemo(
    () =>
      deriveAttention({
        graph,
        executions,
        verificationRuns,
        reviews,
        maintenanceHealth,
      }),
    [graph, executions, verificationRuns, reviews, maintenanceHealth],
  );

  const stateCounts = React.useMemo(
    () => (graph ? countByState(graph.nodes) : []),
    [graph],
  );

  const setTab = (value: string) => {
    setSearchParams(value === 'overview' ? {} : { tab: value }, { replace: true });
  };

  if (loading && !refreshingAt) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Workbench" description="Loading the engineering workspace…" />
        <LoadingState label="Loading the workbench…" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Developer Workbench"
        title={project ? project.name : 'Workbench'}
        description={
          project
            ? `The authoritative engineering state of this project — work, executions, changes, verification, reviews, deployments, maintenance, activity.`
            : 'Project details unavailable — the backend could not be reached for this project.'
        }
        actions={
          <Button variant="outline" size="sm" onClick={loadAll} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      {error && <ErrorState message={error} onRetry={loadAll} />}
      {advisoryNote && (
        <div className="rounded-md border border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          {advisoryNote}
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* --- Overview ------------------------------------------------------------ */}
        <TabsContent value="overview" className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4" />
                  What needs attention
                </CardTitle>
                <CardDescription>
                  Derived from the authoritative graph, executions, verification,
                  reviews, and maintenance signals.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {attention.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CircleCheckBig className="h-4 w-4 text-success" />
                    Nothing needs attention right now.
                  </div>
                ) : (
                  attention.map((item, idx) => (
                    <RowCard
                      key={`${item.kind}-${idx}`}
                      to={item.href}
                      title={item.label}
                      meta={item.detail}
                      badge={
                        <Badge variant={item.kind === 'failed-verification' ? 'destructive' : 'secondary'}>
                          {titleCase(item.kind)}
                        </Badge>
                      }
                    />
                  ))
                )}
              </CardContent>
            </Card>

            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ArrowRight className="h-4 w-4" />
                    What should happen next
                  </CardTitle>
                  <CardDescription>
                    The workflow authority's next eligible work item and the
                    planner's open recommendations.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {graph === null ? (
                    <div className="text-sm text-muted-foreground">Work graph unavailable.</div>
                  ) : nextWorkItemId ? (
                    <RowCard
                      to={`/work-items/${nextWorkItemId}`}
                      title={
                        nodeById.get(nextWorkItemId)
                          ? `${nodeById.get(nextWorkItemId)!.workItemId} — ${nodeById.get(nextWorkItemId)!.title}`
                          : `Next work item ${shortId(nextWorkItemId)}`
                      }
                      meta="The workflow authority's next eligible item (dependencies satisfied, state ready)."
                      badge={<Badge variant="info">Next</Badge>}
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      No eligible next work item (the workflow authority recommends none).
                    </div>
                  )}
                  {planningRecs.map((rec) => (
                    <RowCard
                      key={rec.workItemId}
                      to={`/work-items/${rec.workItemId}`}
                      title={`${rec.workItemHumanId} — ${rec.title}`}
                      meta={rec.planner.whyNow || rec.planner.rationale}
                      badge={<Badge variant="secondary">Planner</Badge>}
                    />
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ActivityIcon className="h-4 w-4" />
                    Health summary
                  </CardTitle>
                  <CardDescription>
                    The runtime authority's provider status for this project.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {runtimeStatus === null ? (
                    <div className="text-sm text-muted-foreground">Runtime status unavailable.</div>
                  ) : (
                    <>
                      <HealthChip label="GitHub" status={runtimeStatus.github?.status} />
                      <HealthChip label="Vercel" status={runtimeStatus.vercel?.status} />
                      <HealthChip label="Architect" status={runtimeStatus.architect?.status} />
                      <HealthChip label="Agent" status={runtimeStatus.agent?.status} />
                    </>
                  )}
                  {deployments.length > 0 && (
                    <RowCard
                      title={`Latest deployment: ${titleCase(deployments[0]!.status)}`}
                      meta={`${shortId(deployments[0]!.commitSha)} on ${deployments[0]!.branch ?? '—'} · ${formatRelative(deployments[0]!.createdAt)}`}
                      badge={<Badge variant="secondary">Deployment</Badge>}
                    />
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Work state</CardTitle>
              <CardDescription>
                Every work item of the project, counted by the workflow
                authority's own state values.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {stateCounts.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  {graph === null ? 'Work graph unavailable.' : 'No work items yet.'}
                </div>
              ) : (
                stateCounts.map(({ state, count }) => (
                  <button
                    key={state}
                    type="button"
                    onClick={() => setTab('graph')}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:border-primary/40"
                  >
                    <StatusBadge value={state} />
                    <span className="font-mono text-foreground">{count}</span>
                  </button>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent activity</CardTitle>
              <CardDescription>The audit authority's event feed for this project.</CardDescription>
            </CardHeader>
            <CardContent className="flex max-h-96 flex-col gap-2 overflow-y-auto">
              {auditEvents.length === 0 ? (
                <div className="text-sm text-muted-foreground">No recent activity recorded.</div>
              ) : (
                auditEvents.slice(0, 8).map((event, idx) => (
                  <AuditEventItem key={event.id ?? idx} event={event} />
                ))
              )}
              <Link
                to="activity"
                className="self-start text-xs text-primary underline-offset-4 hover:underline"
              >
                View full activity →
              </Link>
            </CardContent>
          </Card>
        </TabsContent>

        {/* --- Work Graph --------------------------------------------------------- */}
        <TabsContent value="graph" className="flex flex-col gap-4">
          {graph === null ? (
            <ErrorState message="The work graph is unavailable for this project." onRetry={loadAll} />
          ) : (
            <WorkGraphBoard graph={graph} />
          )}
        </TabsContent>

        {/* --- Work ---------------------------------------------------------------- */}
        <TabsContent value="work" className="flex flex-col gap-4">
          {graph === null ? (
            <ErrorState message="The work graph is unavailable for this project." onRetry={loadAll} />
          ) : graph.nodes.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="No work items"
              description="This project has no work items yet."
            />
          ) : (
            <div className="flex flex-col gap-2">
              {graph.nodes.map((n) => (
                <RowCard
                  key={n.id}
                  to={`/work-items/${n.id}`}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-primary">{n.workItemId}</span>
                      {n.title}
                    </span>
                  }
                  meta={
                    <span>
                      {n.objective ? `${n.objective.slice(0, 120)}${n.objective.length > 120 ? '…' : ''} · ` : ''}
                      updated {formatRelative(n.updatedAt)}
                    </span>
                  }
                  badge={
                    <span className="flex items-center gap-1.5">
                      {n.unsatisfiedDependencies.length > 0 && !n.completed && (
                        <Badge variant="destructive">Blocked</Badge>
                      )}
                      {n.completed ? (
                        <Badge variant="success">Completed</Badge>
                      ) : (
                        <StatusBadge value={n.currentState} />
                      )}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* --- Executions --------------------------------------------------------- */}
        <TabsContent value="executions" className="flex flex-col gap-4">
          {executions.length === 0 ? (
            <EmptyState
              icon={Cpu}
              title="No executions"
              description="No execution records exist for this project yet (the /agents authority reports none)."
            />
          ) : (
            executions.map((e) => (
              <RowCard
                key={e.executionId}
                to={e.workItemId ? `/work-items/${e.workItemId}` : undefined}
                title={
                  <span className="font-mono text-xs">{e.executionId}</span>
                }
                meta={
                  <span>
                    {e.provider}
                    {e.model ? ` / ${e.model}` : ''} · {e.mode}
                    {e.branch ? ` · ${e.branch}` : ''}
                    {e.completedAt ? ` · completed ${formatRelative(e.completedAt)}` : e.startedAt ? ` · started ${formatRelative(e.startedAt)}` : ' · not started'}
                  </span>
                }
                badge={<StatusBadge value={e.status} />}
              />
            ))
          )}
        </TabsContent>

        {/* --- Changes --------------------------------------------------------- */}
        <TabsContent value="changes" className="flex flex-col gap-4">
          {prAssociations.length === 0 ? (
            <EmptyState
              icon={GitPullRequest}
              title="No changes"
              description="No pull-request associations exist for this project yet (the GitHub-derived identity authority reports none)."
            />
          ) : (
            prAssociations.map((pr) => (
              <RowCard
                key={pr.id}
                to={`/work-items/${pr.workItemId}`}
                title={<span className="font-mono text-xs">PR {pr.externalPrId}</span>}
                meta={
                  <span>
                    {pr.branch ?? '—'} → {pr.baseBranch ?? '—'}
                    {pr.repositoryRef ? ` · ${pr.repositoryRef}` : ''}
                    {pr.headCommit ? ` · head ${shortId(pr.headCommit)}` : ''}
                    {pr.createdAt ? ` · created ${formatRelative(pr.createdAt)}` : ''}
                  </span>
                }
                badge={<StatusBadge value={pr.status} />}
              />
            ))
          )}
        </TabsContent>

        {/* --- Verification --------------------------------------------------------- */}
        <TabsContent value="verification" className="flex flex-col gap-4">
          {verificationRuns.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No verification runs"
              description="The /verification authority reports no runs for this project yet."
            />
          ) : (
            verificationRuns.map((run) => {
              const summary = run.summary as Record<string, unknown> | null;
              const pass = typeof summary?.criteriaPass === 'number' ? summary.criteriaPass : null;
              const fail = typeof summary?.criteriaFail === 'number' ? summary.criteriaFail : null;
              return (
                <RowCard
                  key={run.id}
                  to={`/work-items/${run.workItemId}`}
                  title={<span className="font-mono text-xs">Run {shortId(run.id)}</span>}
                  meta={
                    <span>
                      {titleCase(run.source)}
                      {run.sourceRef ? ` (${run.sourceRef})` : ''} · execution {run.executionId}
                      {pass !== null && fail !== null ? ` · ${pass} pass / ${fail} fail` : ''}
                      {run.finishedAt ? ` · finished ${formatRelative(run.finishedAt)}` : ''}
                    </span>
                  }
                  badge={<StatusBadge value={run.status} />}
                />
              );
            })
          )}
        </TabsContent>

        {/* --- Reviews --------------------------------------------------------- */}
        <TabsContent value="reviews" className="flex flex-col gap-4">
          {reviews.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No reviews"
              description="The /reviews authority reports none for this project yet."
            />
          ) : (
            reviews.map((review) => (
              <RowCard
                key={review.id}
                to={`/work-items/${review.workItemId}`}
                title={<span className="font-mono text-xs">Review {shortId(review.id)}</span>}
                meta={
                  <span>
                    {titleCase(review.source)}
                    {review.reviewer ? ` · ${review.reviewer}` : ''}
                    {review.summary ? ` · ${review.summary.slice(0, 100)}` : ''}
                    {review.createdAt ? ` · ${formatRelative(review.createdAt)}` : ''}
                  </span>
                }
                badge={
                  review.outcome ? <StatusBadge value={review.outcome} /> : <StatusBadge value={review.status} />
                }
              />
            ))
          )}
        </TabsContent>

        {/* --- Deployments --------------------------------------------------------- */}
        <TabsContent value="deployments" className="flex flex-col gap-4">
          {deployments.length === 0 ? (
            <EmptyState
              icon={Rocket}
              title="No deployments"
              description="The runtime authority reports no deployments for this project yet."
            />
          ) : (
            deployments.map((d) => (
              <RowCard
                key={d.id}
                title={
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs">{shortId(d.externalId)}</span>
                    {d.previewUrl && (
                      <a
                        href={d.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary underline-offset-4 hover:underline"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        preview ↗
                      </a>
                    )}
                  </span>
                }
                meta={
                  <span>
                    {shortId(d.commitSha)} on {d.branch ?? '—'} · created {formatRelative(d.createdAt)}
                  </span>
                }
                badge={<StatusBadge value={d.status} />}
              />
            ))
          )}
        </TabsContent>

        {/* --- Maintenance --------------------------------------------------------- */}
        <TabsContent value="maintenance" className="flex flex-col gap-4">
          {maintenanceHealth === null ? (
            <EmptyState
              icon={Stethoscope}
              title="Maintenance health unavailable"
              description="The maintenance authority could not be reached, or this project has no frozen architecture version to inspect (no data is invented)."
            />
          ) : maintenanceHealth.totalSignals === 0 ? (
            <EmptyState
              icon={Stethoscope}
              title="No maintenance signals"
              description="The maintenance authority reports no emerging maintenance for this architecture version."
            />
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Maintenance health</CardTitle>
                  <CardDescription>
                    {maintenanceHealth.totalSignals} signal
                    {maintenanceHealth.totalSignals === 1 ? '' : 's'} (the maintenance authority's
                    assessment of this architecture version).
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {Object.entries(maintenanceHealth.bySeverity).map(([sev, count]) => (
                    <Badge key={sev} variant={sev === 'critical' || sev === 'high' ? 'destructive' : 'secondary'}>
                      {titleCase(sev)}: {count}
                    </Badge>
                  ))}
                  {Object.entries(maintenanceHealth.byCategory).map(([cat, count]) => (
                    <Badge key={cat} variant="secondary">
                      {titleCase(cat)}: {count}
                    </Badge>
                  ))}
                </CardContent>
              </Card>
              {maintenanceHealth.signals.map((s) => (
                <RowCard
                  key={s.workItemId}
                  to={`/work-items/${s.workItemId}`}
                  title={`${s.workItemHumanId} — ${s.title}`}
                  meta={
                    <span>
                      {titleCase(s.planner.maintenance?.category ?? 'unknown')}
                      {s.planner.maintenance?.severity ? ` · ${s.planner.maintenance.severity}` : ''}
                      {s.planner.maintenance?.advisoryId ? ` · ${s.planner.maintenance.advisoryId}` : ''}
                      {` · ${s.planner.whyNow}`}
                    </span>
                  }
                  badge={
                    <StatusBadge
                      value={s.planner.maintenance?.severity ?? null}
                    />
                  }
                />
              ))}
            </>
          )}
        </TabsContent>

        {/* --- Activity --------------------------------------------------------- */}
        <TabsContent value="activity" className="flex flex-col gap-4">
          {auditEvents.length === 0 ? (
            <EmptyState
              icon={ActivityIcon}
              title="No activity"
              description="The audit authority reports no events for this project yet."
            />
          ) : (
            <div className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto">
              {auditEvents.map((event, idx) => (
                <AuditEventItem key={event.id ?? idx} event={event} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

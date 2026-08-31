/**
 * WORK-068 test helpers — deterministic fixtures for the feedback-conversion
 * suite. No wall-clock reads: every clock is injected; every timestamp is a
 * recorded fixture value. The fake `/work-items` intake models the REAL
 * authority contract: `create` enforces the UNIQUE(architecture_version_id,
 * work_item_id) constraint (SQLSTATE 23505) exactly like wfos_work_items.
 */
import {
  DefaultFeedbackConversionService,
  InMemoryFeedbackConversionRecordRepository,
} from '../../src/feedback-conversion/index.js';
import type {
  ConversionRecord,
  EngineeringSignalRecord,
  FeedbackConversionContext,
  FeedbackConversionService,
  WorkItemIntake,
  WorkItemRecord,
} from '../../src/feedback-conversion/index.js';

/** A fixed, deterministic clock (the injected-time discipline). */
export function fixedClock(startIso: string, stepMs = 0): () => Date {
  let current = Date.parse(startIso);
  return () => {
    const now = new Date(current);
    current += stepMs;
    return now;
  };
}

/** A WORK-067 Engineering Signal record fixture (override per test). */
export function signalFixture(
  overrides: Partial<EngineeringSignalRecord> = {},
): EngineeringSignalRecord {
  return {
    signalId: 'sig_abc123def456789abc123def',
    identityFingerprint: 'f'.repeat(64),
    tenantId: 'tenant-1',
    projectId: 'project-1',
    environmentId: 'env-prod-1',
    logicalFailureKey: 'validation:execution:dependency-blocked-admission',
    sources: ['validation'],
    occurrences: [
      { observedAt: '2026-09-01T12:00:00Z', severity: 'high' as const },
      { observedAt: '2026-09-02T12:00:00Z', severity: 'high' as const },
    ],
    firstObservedAt: '2026-09-01T12:00:00Z',
    lastObservedAt: '2026-09-02T12:00:00Z',
    latestSeverity: 'high' as const,
    ...overrides,
  };
}

/**
 * The fake `/work-items` PUBLIC intake: an in-memory WorkItemRepository
 * stand-in that models the authority's REAL contract — create / update /
 * findByArchitectureVersion with the UNIQUE(architecture_version_id,
 * work_item_id) constraint (23505 on conflict), exactly like the real
 * wfos_work_items table the WORK-040 planner composes.
 */
export class FakeWorkItemIntake implements WorkItemIntake {
  private readonly items: WorkItemRecord[] = [];
  private nextInternalId = 1;
  /** When true, the NEXT create throws a non-unique error (intake failure). */
  public failNextCreate: Error | null = null;

  async create(input: {
    architectureVersionId: string;
    workItemId: string;
    title: string;
    objective?: string;
    scope?: string;
    metadata?: Record<string, unknown>;
    architectureImpact?: 'low' | 'medium' | 'high' | null;
  }): Promise<WorkItemRecord> {
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
    // The UNIQUE(architecture_version_id, work_item_id) constraint.
    const conflict = this.items.find(
      (wi) =>
        (wi as unknown as { architectureVersionId?: string }).architectureVersionId ===
          input.architectureVersionId && wi.workItemId === input.workItemId,
    );
    if (conflict) {
      const err = new Error(
        `duplicate key value violates unique constraint "wfos_work_items_architecture_version_id_work_item_id_key"`,
      );
      (err as { code?: string }).code = '23505';
      throw err;
    }
    const record: WorkItemRecord & { architectureVersionId: string } = {
      id: `wi-internal-${this.nextInternalId++}`,
      workItemId: input.workItemId,
      title: input.title,
      completed: false,
      metadata: input.metadata ? structuredClone(input.metadata) : {},
      architectureVersionId: input.architectureVersionId,
    };
    this.items.push(record);
    return structuredClone(record);
  }

  async findByArchitectureVersion(
    architectureVersionId: string,
  ): Promise<WorkItemRecord[]> {
    return this.items
      .filter(
        (wi) =>
          (wi as unknown as { architectureVersionId?: string }).architectureVersionId ===
          architectureVersionId,
      )
      .map((wi) => structuredClone(wi));
  }

  async update(
    id: string,
    input: { metadata?: Record<string, unknown> },
  ): Promise<WorkItemRecord | null> {
    const idx = this.items.findIndex((wi) => wi.id === id);
    if (idx === -1) return null;
    if (input.metadata) {
      this.items[idx] = {
        ...this.items[idx]!,
        metadata: structuredClone(input.metadata),
      } as WorkItemRecord & { architectureVersionId: string };
    }
    return structuredClone(this.items[idx]!);
  }

  /** Test helper: mark an item completed (the authority's internal path). */
  markCompleted(id: string): void {
    const idx = this.items.findIndex((wi) => wi.id === id);
    if (idx !== -1) {
      this.items[idx] = { ...this.items[idx]!, completed: true } as WorkItemRecord & {
        architectureVersionId: string;
      };
    }
  }

  /** Test helper: the raw open-item count. */
  countOpen(): number {
    return this.items.filter((wi) => !wi.completed).length;
  }
}

/** A fake WORK-067 signal reader over a fixed signal set. */
export class FakeSignalReader {
  private readonly signals = new Map<string, EngineeringSignalRecord>();
  constructor(signals: readonly EngineeringSignalRecord[] = []) {
    for (const s of signals) this.signals.set(s.signalId, s);
  }
  async findSignal(signalId: string): Promise<EngineeringSignalRecord | null> {
    return this.signals.get(signalId) ?? null;
  }
}

/** A fake architecture-version scope pair (the planner's defense-in-depth). */
export class FakeArchitectureScope {
  constructor(
    private readonly version: { id: string; architectureId: string },
    private readonly architecture: { id: string; projectId: string },
  ) {}
  get versionReader() {
    return {
      findById: async (id: string) =>
        id === this.version.id ? { architectureId: this.version.architectureId } : null,
    };
  }
  get architectureReader() {
    return {
      findById: async (id: string) =>
        id === this.architecture.id ? { projectId: this.architecture.projectId } : null,
    };
  }
}

/**
 * A fake scope over MULTIPLE architecture versions of ONE architecture (the
 * cross-version regression harness — the PR #107 architect-review fence:
 * UNIQUE(architecture_version_id, work_item_id) means the same logical
 * problem under two versions is TWO governed Work Items).
 */
export class FakeMultiVersionScope {
  constructor(
    private readonly versionIds: readonly string[],
    private readonly architectureId = 'arch-1',
    private readonly projectId = 'project-1',
  ) {}
  get versionReader() {
    return {
      findById: async (id: string) =>
        this.versionIds.includes(id) ? { architectureId: this.architectureId } : null,
    };
  }
  get architectureReader() {
    return {
      findById: async (id: string) =>
        id === this.architectureId ? { projectId: this.projectId } : null,
    };
  }
}

/**
 * Build a conversion scenario over MULTIPLE architecture versions: one ctx
 * whose version reader accepts every listed version (all belonging to the
 * same project through the same architecture).
 */
export function buildMultiVersionScenario(overrides: {
  versionIds?: readonly string[];
  tenantId?: string;
  projectId?: string;
  signals?: readonly EngineeringSignalRecord[];
  clock?: () => Date;
} = {}): {
  service: FeedbackConversionService;
  intake: FakeWorkItemIntake;
  signalReader: FakeSignalReader;
  records: InMemoryFeedbackConversionRecordRepository;
  ctx: FeedbackConversionContext;
  versionIds: string[];
} {
  const versionIds = overrides.versionIds ?? ['archver-1', 'archver-2'];
  const tenantId = overrides.tenantId ?? 'tenant-1';
  const projectId = overrides.projectId ?? 'project-1';
  const intake = new FakeWorkItemIntake();
  const signalReader = new FakeSignalReader(overrides.signals ?? [signalFixture()]);
  const scope = new FakeMultiVersionScope(versionIds, 'arch-1', projectId);
  const records = new InMemoryFeedbackConversionRecordRepository();
  const service = new DefaultFeedbackConversionService({
    recordRepository: records,
    now: overrides.clock ?? fixedClock('2026-09-03T00:00:00Z'),
  });
  const ctx: FeedbackConversionContext = {
    tenantId,
    projectId,
    engineeringSignalService: signalReader,
    workItemRepository: intake,
    architectureVersionRepository: scope.versionReader,
    architectureRepository: scope.architectureReader,
  };
  return { service, intake, signalReader, records, ctx, versionIds: [...versionIds] };
}

/** Build a conversion service + a wired ctx over the fakes. */
export function buildService(overrides: {
  clock?: () => Date;
  signals?: readonly EngineeringSignalRecord[];
  versionId?: string;
  architectureId?: string;
  projectId?: string;
  tenantId?: string;
  /** The architecture's OWN project binding (defaults to projectId — override to force version-not-in-project). */
  archProjectId?: string;
} = {}): {
  service: FeedbackConversionService;
  intake: FakeWorkItemIntake;
  signalReader: FakeSignalReader;
  records: InMemoryFeedbackConversionRecordRepository;
  ctx: FeedbackConversionContext;
  versionId: string;
} {
  const intake = new FakeWorkItemIntake();
  const signalReader = new FakeSignalReader(overrides.signals ?? [signalFixture()]);
  const scope = new FakeArchitectureScope(
    { id: overrides.versionId ?? 'archver-1', architectureId: overrides.architectureId ?? 'arch-1' },
    { id: overrides.architectureId ?? 'arch-1', projectId: overrides.archProjectId ?? overrides.projectId ?? 'project-1' },
  );
  const records = new InMemoryFeedbackConversionRecordRepository();
  const service = new DefaultFeedbackConversionService({
    recordRepository: records,
    now: overrides.clock ?? fixedClock('2026-09-03T00:00:00Z'),
  });
  const ctx: FeedbackConversionContext = {
    tenantId: overrides.tenantId ?? 'tenant-1',
    projectId: overrides.projectId ?? 'project-1',
    engineeringSignalService: signalReader,
    workItemRepository: intake,
    architectureVersionRepository: scope.versionReader,
    architectureRepository: scope.architectureReader,
  };
  return { service, intake, signalReader, records, ctx, versionId: overrides.versionId ?? 'archver-1' };
}

/** Read the feedbackConversion metadata off a work item (test-side read). */
export function readFeedback(
  item: WorkItemRecord,
): { feedbackConversion?: Record<string, unknown> } {
  return item.metadata as { feedbackConversion?: Record<string, unknown> };
}

/** Extract a conversion record list as plain summaries. */
export function summarizeRecords(records: readonly ConversionRecord[]): string[] {
  return records.map((r) => `${r.decision}:${r.signalId}`);
}

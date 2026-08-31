import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

/**
 * WORK-068 — the REAL mutation-kill proofs (§15 "Required proof" #6 + the
 * PR #107 architect-review BLOCKER 2).
 *
 * The Work Order demands: "removing the no-second-authority boundary, the
 * provenance binding, or the no-silent-autonomous-creation rule makes the
 * corresponding test FAIL." The first delivery attempted to satisfy this
 * with defect-shaped test DOUBLES built in the test file — which prove the
 * bad behavior exists in the double, NOT that the real invariant tests
 * turn red when the real production boundary is removed. The architect
 * review correctly rejected that.
 *
 * This harness implements a TRUE source-level mutation kill:
 *
 *   1. READ the actual production source file (src/feedback-conversion/
 *      internal/…). Nothing is hand-copied — the mutant is DERIVED from the
 *      real source text.
 *   2. APPLY one precise textual mutation that removes/neutralizes ONE
 *      guarded production boundary. The mutation must match its target
 *      EXACTLY ONCE — if the production source changed shape, the proof
 *      fails LOUDLY (a kill can never silently rot into a vacuous pass).
 *   3. EMIT the mutated module to tests/feedback-conversion/__mutants__/
 *      <slug>.ts with every relative import specifier rewritten to the REAL
 *      files — the mutant's collaborators (types, identity derivations,
 *      assessment, priority, the injected record repository) are the REAL
 *      production modules; ONLY the mutated boundary differs. src/ is never
 *      touched (the transient file lives and dies inside the test tree).
 *   4. IMPORT the mutant through vitest's transform pipeline.
 *   5. RUN THE INVARIANT SCENARIO — the same assertions the green domain
 *      suite makes, with named messages — TWICE:
 *        GREEN: against the REAL production module → the invariant HOLDS;
 *        RED:   against the MUTATED module         → the invariant scenario
 *              THROWS (the corresponding invariant test demonstrably turns
 *              red with the boundary removed).
 *   6. REMOVE the transient mutant file (finally + a beforeAll/afterAll
 *      sweep, so a crashed run can never leave one behind).
 *
 * Each kill pins the SPECIFIC invariant failure message, so an unrelated
 * crash (a broken import, a typo in the mutation) can never masquerade as
 * a kill. The GREEN half of each case is the "restore the guarded
 * implementation → green" half of the discipline, run in the same test.
 */
import {
  DefaultFeedbackConversionService,
  deriveConversionIdentity,
} from '../../src/feedback-conversion/index.js';
import type {
  ConversionResult,
  FeedbackConversionRecordRepository,
  FeedbackConversionService,
} from '../../src/feedback-conversion/index.js';
import {
  signalFixture,
  fixedClock,
  buildService,
  buildMultiVersionScenario,
} from './helpers.js';

const FC_INTERNAL_DIR = join(import.meta.dirname, '..', '..', 'src', 'feedback-conversion', 'internal');
const FC_DOMAIN_DIR = join(import.meta.dirname, '..', '..', 'src', 'feedback-conversion');
const FC_SERVICE = join(FC_INTERNAL_DIR, 'feedback-conversion-service.ts');
const FC_IDENTITY = join(FC_INTERNAL_DIR, 'conversion-identity.ts');
const MUTANTS_DIR = join(import.meta.dirname, '__mutants__');

// ============================================================================
// The harness
// ============================================================================

/** A mutation that did not apply is a ROTTED proof — fail loudly, never pass. */
function applyOnce(
  label: string,
  src: string,
  target: string,
  replacement: string,
): string {
  const first = src.indexOf(target);
  if (first === -1) {
    throw new Error(
      `MUTATION ${label}: the target boundary is no longer present in the production source — the kill proof must be updated (it can never silently pass when production changes shape)`,
    );
  }
  if (src.indexOf(target, first + 1) !== -1) {
    throw new Error(
      `MUTATION ${label}: the target boundary is ambiguous (multiple occurrences) — the kill proof must pin exactly ONE boundary`,
    );
  }
  return src.slice(0, first) + replacement + src.slice(first + target.length);
}

/**
 * Rewrite the mutant's relative import specifiers to point at the REAL files
 * (the mutant lives in tests/feedback-conversion/__mutants__/, the original
 * in src/feedback-conversion/internal/ — every relative specifier is rebased
 * so the mutant's collaborators remain the REAL production modules).
 */
function rewriteRelativeImports(
  src: string,
  originalDir: string,
  mutantDir: string,
): string {
  return src.replace(
    /(from\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (_whole: string, prefix: string, quote: string, spec: string) => {
      const absolute = resolve(originalDir, spec);
      return `${prefix}${quote}${relative(mutantDir, absolute)}${quote}`;
    },
  );
}

/** Read + mutate the REAL production source (the mutation must change it). */
function mutateSource(
  slug: string,
  sourceFile: string,
  mutate: (src: string) => string,
): string {
  const original = readFileSync(sourceFile, 'utf8');
  const mutated = mutate(original);
  if (mutated === original) {
    throw new Error(
      `MUTATION ${slug}: the mutation did not change the source — the kill proof rotted`,
    );
  }
  return mutated;
}

/**
 * The statically-analyzable import thunks — vite's dynamic-import helper
 * requires LITERAL specifiers (a runtime-computed specifier is rejected as
 * "Unknown variable dynamic import"). Each thunk names its mutant file
 * LITERALLY; the file itself is written at test runtime, milliseconds
 * before the thunk is invoked (the vite-node runner resolves the specifier
 * at invocation time — proven by the smoke-checked mechanism). TypeScript
 * cannot see the runtime-only files, hence the @ts-expect-error lines
 * (the repo's established pattern for runtime-only module shapes).
 */
const MUTANT_IMPORTS: Record<string, () => Promise<Record<string, unknown>>> = {
  'kill-1-parallel-store': () =>
    // @ts-expect-error — the mutant file is written at test runtime only
    import('./__mutants__/kill-1-parallel-store.ts') as Promise<Record<string, unknown>>,
  'kill-2-hollow-assessment': () =>
    // @ts-expect-error — the mutant file is written at test runtime only
    import('./__mutants__/kill-2-hollow-assessment.ts') as Promise<Record<string, unknown>>,
  'kill-3-no-provenance': () =>
    // @ts-expect-error — the mutant file is written at test runtime only
    import('./__mutants__/kill-3-no-provenance.ts') as Promise<Record<string, unknown>>,
  'kill-4-fresh-keys': () =>
    // @ts-expect-error — the mutant file is written at test runtime only
    import('./__mutants__/kill-4-fresh-keys.ts') as Promise<Record<string, unknown>>,
  'kill-5-scopeless-identity': () =>
    // @ts-expect-error — the mutant file is written at test runtime only
    import('./__mutants__/kill-5-scopeless-identity.ts') as Promise<Record<string, unknown>>,
  'kill-7-versionless-record-id': () =>
    // @ts-expect-error — the mutant file is written at test runtime only
    import('./__mutants__/kill-7-versionless-record-id.ts') as Promise<Record<string, unknown>>,
};

/**
 * Emit + import ONE mutated production module. The transient file is
 * removed in `finally` (and the whole __mutants__/ directory is swept
 * before/after the suite), so a mutant can never leak into src/ or the
 * repository — only the runtime module instance survives the call.
 */
async function loadMutantModule(
  slug: string,
  sourceFile: string,
  mutate: (src: string) => string,
): Promise<Record<string, unknown>> {
  const mutated = mutateSource(slug, sourceFile, mutate);
  const withImports = rewriteRelativeImports(mutated, dirname(sourceFile), MUTANTS_DIR);
  mkdirSync(MUTANTS_DIR, { recursive: true });
  const mutantPath = join(MUTANTS_DIR, `${slug}.ts`);
  writeFileSync(mutantPath, withImports, 'utf8');
  const importThunk = MUTANT_IMPORTS[slug];
  if (!importThunk) {
    rmSync(mutantPath, { force: true });
    throw new Error(
      `MUTATION ${slug}: no static import thunk registered — every mutant needs a literal-specifier entry in MUTANT_IMPORTS (vite requires literal dynamic-import specifiers)`,
    );
  }
  try {
    return await importThunk();
  } finally {
    rmSync(mutantPath, { force: true });
  }
}

// ============================================================================
// The invariant scenarios (the same invariants the green domain suite
// asserts — named so a kill can be pinned to its SPECIFIC failure)
// ============================================================================

type ServiceCtor = new (deps: {
  recordRepository: FeedbackConversionRecordRepository;
  now?: () => Date;
}) => FeedbackConversionService;

function makeService(ctor: ServiceCtor, records: FeedbackConversionRecordRepository): FeedbackConversionService {
  return new ctor({ recordRepository: records, now: fixedClock('2026-09-03T00:00:00Z') });
}

/** The one-authority invariant (deduplication.test.ts / the §15 mutation 1). */
async function invariantOneAuthority(ctor: ServiceCtor): Promise<void> {
  const signal = signalFixture();
  const { ctx, intake, records } = buildService({ signals: [signal] });
  const service = makeService(ctor, records);
  const result = await service.convertSignal(
    { signalId: signal.signalId, architectureVersionId: 'archver-1' },
    ctx,
  );
  const authoritative = await intake.findByArchitectureVersion('archver-1');
  expect(
    authoritative.some((wi) => wi.id === result.workItem?.id),
    'INVARIANT (one Work Item authority): the proposed Work Item MUST be readable through the existing /work-items intake — a conversion that writes to any parallel store is invisible to the authority',
  ).toBe(true);
}

/** The no-silent-conversion invariant (assessment.test.ts / §15 mutation 2). */
async function invariantAssessmentCarried(ctor: ServiceCtor): Promise<void> {
  const signal = signalFixture();
  const { ctx, records } = buildService({ signals: [signal] });
  const service = makeService(ctor, records);
  const result = await service.convertSignal(
    { signalId: signal.signalId, architectureVersionId: 'archver-1' },
    ctx,
  );
  expect(
    result.assessment.occurrenceCount,
    'INVARIANT (no silent conversion): the assessment must preserve the signal\'s recorded occurrence count',
  ).toBe(signal.occurrences.length);
  expect(
    result.assessment.factors.length,
    'INVARIANT (no silent conversion): every conversion must carry the deterministic assessment factors — a hollow assessment means the signal became a Work Item without being interpreted',
  ).toBeGreaterThan(0);
  expect(
    result.assessment.environments,
    'INVARIANT (no silent conversion): the assessment must preserve the observed environments',
  ).toContain(signal.environmentId);
  expect(
    result.assessment.reasoning,
    'INVARIANT (no silent conversion): the assessment must carry the deterministic reasoning citing the signal',
  ).toContain('Assessment of Engineering Signal');
}

/** The provenance-preservation invariant (provenance.test.ts / §15 mutation 3). */
async function invariantProvenanceEmbedded(ctor: ServiceCtor): Promise<void> {
  const signal = signalFixture();
  const { ctx, intake, records } = buildService({ signals: [signal] });
  const service = makeService(ctor, records);
  const result = await service.convertSignal(
    { signalId: signal.signalId, architectureVersionId: 'archver-1' },
    ctx,
  );
  const items = await intake.findByArchitectureVersion('archver-1');
  const item = items.find((wi) => wi.id === result.workItem?.id);
  const payload = (
    item?.metadata as { feedbackConversion?: { contributingSignals?: { signalId: string }[] } }
  )?.feedbackConversion;
  expect(
    payload,
    'INVARIANT (provenance preserved): the created Work Item MUST embed metadata.feedbackConversion — a proposal without the payload is free-floating (the chain is not reconstructable)',
  ).toBeDefined();
  expect(
    payload?.contributingSignals?.[0]?.signalId,
    'INVARIANT (provenance preserved): the originating signal id must be preserved EXACTLY in the payload',
  ).toBe(signal.signalId);
}

/** The deduplication invariant (deduplication.test.ts / §15 mutation 4). */
async function invariantDedupNoDuplicates(ctor: ServiceCtor): Promise<void> {
  const signal = signalFixture();
  const { ctx, intake, records } = buildService({ signals: [signal] });
  const service = makeService(ctor, records);
  const first = await service.convertSignal(
    { signalId: signal.signalId, architectureVersionId: 'archver-1' },
    ctx,
  );
  let second: ConversionResult;
  try {
    second = await service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: 'archver-1' },
      ctx,
    );
  } catch (err) {
    // One manifestation of the removed dedup boundary: the re-delivered
    // signal creates a SECOND item and then fails on its own decision log
    // (a re-delivery must CONVERGE — never fail). The invariant test turns
    // red here either way.
    throw new Error(
      `INVARIANT (deduplication): a re-delivered signal for the same logical problem must CONVERGE — never fail on its own decision log: ${(err as Error).message}`,
    );
  }
  expect(first.decision).toBe('proposed');
  expect(
    second.decision,
    'INVARIANT (deduplication): a re-delivered signal for the same logical problem must CONVERGE on the open equivalent (deduplicated) — never silently create a second open Work Item',
  ).toBe('deduplicated');
  expect(
    intake.countOpen(),
    'INVARIANT (deduplication): exactly ONE open Work Item may exist per logical problem',
  ).toBe(1);
  expect(second.workItem?.id).toBe(first.workItem?.id);
}

/** The mandatory-scope-dimensions invariant (conversion-identity.test.ts / §15 mutation 5). */
type DeriveIdentityFn = (input: {
  tenantId: string;
  projectId: string;
  logicalFailureKey: string;
}) => { conversionKey: string };

function invariantScopeNeverCollapses(derive: DeriveIdentityFn): void {
  const key = 'validation:execution:dependency-blocked-admission';
  const tenantAProjectX = derive({ tenantId: 'tenant-A', projectId: 'project-X', logicalFailureKey: key });
  const tenantBProjectX = derive({ tenantId: 'tenant-B', projectId: 'project-X', logicalFailureKey: key });
  const tenantAProjectY = derive({ tenantId: 'tenant-A', projectId: 'project-Y', logicalFailureKey: key });
  expect(
    tenantAProjectX.conversionKey !== tenantBProjectX.conversionKey,
    'INVARIANT (mandatory scope dimensions): tenant A/project X and tenant B/project X must NEVER collapse onto one conversion key',
  ).toBe(true);
  expect(
    tenantAProjectX.conversionKey !== tenantAProjectY.conversionKey,
    'INVARIANT (mandatory scope dimensions): tenant A/project X and tenant A/project Y must NEVER collapse onto one conversion key',
  ).toBe(true);
}

/**
 * The no-autonomous-path invariant — the SAME predicate the
 * static-architecture suite applies to this domain (its INVARIANT 2 scan),
 * replicated here so the kill can run it against a MUTATED source without
 * ever writing into src/ (a source-scanning test turns red exactly when
 * its predicate matches the scanned text).
 */
const AUTONOMOUS_PATH_RE =
  /\b(setInterval|setTimeout\s*\(\s*[^,]*,\s*[0-9]|cron\b|new\s+CronJob|while\s*\(\s*true\b|\.consume\(|poll\(|startBackgroundLoop)/;

function stripCodeComments(src: string): string {
  return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function invariantNoAutonomousPath(files: readonly { name: string; src: string }[]): void {
  for (const { name, src } of files) {
    expect(
      stripCodeComments(src),
      `INVARIANT (no autonomous path): ${name} must contain no timer/interval/cron/queue-consumer/polling path — conversion is an explicit governed invocation only`,
    ).not.toMatch(AUTONOMOUS_PATH_RE);
  }
}

function readDomainSources(): { name: string; src: string }[] {
  const out: { name: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        out.push({ name: relative(FC_DOMAIN_DIR, full), src: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(FC_DOMAIN_DIR);
  expect(out.length, 'the domain source set must be non-empty').toBeGreaterThan(0);
  return out;
}

/**
 * The cross-version decision-record independence invariant
 * (cross-version.test.ts / the PR #107 architect-review BLOCKER 1).
 */
async function invariantCrossVersionRecordIndependence(ctor: ServiceCtor): Promise<void> {
  const signal = signalFixture();
  const { ctx, records } = buildMultiVersionScenario({
    versionIds: ['archver-1', 'archver-2'],
    signals: [signal],
  });
  const service = makeService(ctor, records);
  const resultA = await service.convertSignal(
    { signalId: signal.signalId, architectureVersionId: 'archver-1' },
    ctx,
  );
  let resultB: ConversionResult;
  try {
    resultB = await service.convertSignal(
      { signalId: signal.signalId, architectureVersionId: 'archver-2' },
      ctx,
    );
  } catch (err) {
    // One manifestation of the versionless-record-identity defect: the
    // second version's record collides on the same recordId and the log
    // refuses it (the conversion of version B FAILS after creating its Work
    // Item). The invariant test turns red here either way.
    throw new Error(
      `INVARIANT (cross-version record independence): the conversion under a SECOND architecture version must SUCCEED with an independent decision record — the versionless record-identity defect manifests as a collision failure: ${(err as Error).message}`,
    );
  }
  expect(
    resultB.record.recordId !== resultA.record.recordId,
    'INVARIANT (cross-version record independence): version B\'s decision record must be an INDEPENDENT identity — never version A\'s converged record',
  ).toBe(true);
  expect(
    resultB.record.workItemId === resultB.workItem?.id,
    'INVARIANT (cross-version record independence): record B must reference Work Item B — never Work Item A',
  ).toBe(true);
  expect(
    resultA.record.workItemId === resultA.workItem?.id,
    'INVARIANT (cross-version record independence): record A must reference Work Item A',
  ).toBe(true);
  expect(
    resultA.workItem?.id !== resultB.workItem?.id,
    'INVARIANT (cross-version record independence): two architecture versions create TWO governed Work Items (the UNIQUE(architecture_version_id, work_item_id) fence)',
  ).toBe(true);
}

// ============================================================================
// The kills
// ============================================================================

describe('WORK-068 — the REAL mutation-kill proofs (the production boundary is removed from the ACTUAL source; the invariant test demonstrably turns red)', () => {
  beforeAll(() => {
    // Sweep any stray mutant from a crashed earlier run, then start clean.
    rmSync(MUTANTS_DIR, { recursive: true, force: true });
    mkdirSync(MUTANTS_DIR, { recursive: true });
  });
  afterAll(() => {
    rmSync(MUTANTS_DIR, { recursive: true, force: true });
  });

  it('KILL 1 — bypassing the /work-items intake (a parallel store): removing the boundary makes the one-authority invariant test FAIL', async () => {
    // GREEN — the real production module holds the invariant:
    await invariantOneAuthority(DefaultFeedbackConversionService);
    // RED — the SAME production source with the intake call REPLACED by a
    // parallel-store write (the created item never reaches the authority):
    const mod = await loadMutantModule('kill-1-parallel-store', FC_SERVICE, (src) =>
      applyOnce(
        'KILL 1',
        src,
        'const created = await ctx.workItemRepository.create({',
        'const created = await (globalThis.__W68_KILL1__ ??= { create: async (i) => ({ id: \'parallel-store-1\', workItemId: i.workItemId, title: i.title, completed: false, metadata: i.metadata ?? {} }) }).create({',
      ),
    );
    await expect(
      invariantOneAuthority((mod as { DefaultFeedbackConversionService: ServiceCtor }).DefaultFeedbackConversionService),
    ).rejects.toThrow('INVARIANT (one Work Item authority)');
  });

  it('KILL 2 — bypassing the assessment (a hollow shell with the count faked to pass the guard): removing the boundary makes the no-silent-conversion invariant test FAIL', async () => {
    // GREEN — the real production module holds the invariant:
    await invariantAssessmentCarried(DefaultFeedbackConversionService);
    // RED — the assessment step REPLACED by a hollow shell (occurrenceCount
    // faked so even the internal validity guard passes — the conversion
    // proceeds WITHOUT ever interpreting the signal):
    const mod = await loadMutantModule('kill-2-hollow-assessment', FC_SERVICE, (src) =>
      applyOnce(
        'KILL 2',
        src,
        'const assessment = assessSignal(signal, backlogContext);',
        'const assessment = { signalId: signal.signalId, signalFingerprint: \'\', tenantId: signal.tenantId, projectId: signal.projectId, environments: [], sources: [], occurrenceCount: signal.occurrences.length, firstObservedAt: signal.firstObservedAt, lastObservedAt: signal.lastObservedAt, latestSeverity: signal.latestSeverity, severityInterpretation: \'\', recurrenceSpan: \'\', backlogContext, factors: [], reasoning: \'\' };',
      ),
    );
    await expect(
      invariantAssessmentCarried((mod as { DefaultFeedbackConversionService: ServiceCtor }).DefaultFeedbackConversionService),
    ).rejects.toThrow('INVARIANT (no silent conversion)');
  });

  it('KILL 3 — stripping the provenance binding from the create: removing the boundary makes the provenance-preservation invariant test FAIL', async () => {
    // GREEN — the real production module holds the invariant:
    await invariantProvenanceEmbedded(DefaultFeedbackConversionService);
    // RED — the create WITHOUT metadata.feedbackConversion:
    const mod = await loadMutantModule('kill-3-no-provenance', FC_SERVICE, (src) =>
      applyOnce(
        'KILL 3',
        src,
        'metadata: { feedbackConversion: metadata },',
        'metadata: {},',
      ),
    );
    await expect(
      invariantProvenanceEmbedded((mod as { DefaultFeedbackConversionService: ServiceCtor }).DefaultFeedbackConversionService),
    ).rejects.toThrow('INVARIANT (provenance preserved)');
  });

  it('KILL 4 — removing deduplication (a fresh unique key per create): removing the boundary makes the no-duplicate-open-items invariant test FAIL', async () => {
    // GREEN — the real production module holds the invariant:
    await invariantDedupNoDuplicates(DefaultFeedbackConversionService);
    // RED — every create invents a UNIQUE work-item id (the deterministic
    // stable key removed — the backlog find can never match):
    const mod = await loadMutantModule('kill-4-fresh-keys', FC_SERVICE, (src) =>
      applyOnce(
        'KILL 4',
        src,
        'workItemId: identity.conversionKey,',
        'workItemId: `${identity.conversionKey}-${((globalThis.__W68_KILL4__ ??= 0), ++globalThis.__W68_KILL4__)}`,',
      ),
    );
    await expect(
      invariantDedupNoDuplicates((mod as { DefaultFeedbackConversionService: ServiceCtor }).DefaultFeedbackConversionService),
    ).rejects.toThrow('INVARIANT (deduplication)');
  });

  it('KILL 5 — removing the tenant/project identity dimensions (a scopeless key): removing the boundary makes the cross-scope-collapse invariant test FAIL', async () => {
    // GREEN — the real production module holds the invariant:
    invariantScopeNeverCollapses(deriveConversionIdentity);
    // RED — the canonicalization WITHOUT the tenant + project dimensions
    // (the logical failure key alone):
    const mod = await loadMutantModule('kill-5-scopeless-identity', FC_IDENTITY, (src) =>
      applyOnce(
        'KILL 5',
        src,
        '  return JSON.stringify([\n    input.tenantId,\n    input.projectId,\n    input.logicalFailureKey,\n  ]);',
        '  return JSON.stringify([\n    input.logicalFailureKey,\n  ]);',
      ),
    );
    expect(() =>
      invariantScopeNeverCollapses(
        (mod as { deriveConversionIdentity: DeriveIdentityFn }).deriveConversionIdentity,
      ),
    ).toThrow('INVARIANT (mandatory scope dimensions)');
  });

  it('KILL 6 — introducing an autonomous conversion path: mutating the source makes the no-autonomous-path invariant (the SAME predicate the static-architecture suite scans with) FAIL', async () => {
    // GREEN — the real production sources contain no autonomous path:
    invariantNoAutonomousPath(readDomainSources());
    // RED — the SAME service source with an autonomous conversion loop
    // appended: the scanning predicate (the static-architecture INVARIANT 2
    // rule, replicated verbatim) flags the mutated file — the
    // source-scanning invariant test turns red. (The mutant text is scanned
    // only — nothing is ever written into src/.)
    const mutatedService = mutateSource('KILL 6', FC_SERVICE, (src) =>
      `${src}\n// The mutation: an autonomous conversion loop.\nsetInterval(() => { void 0; }, 5000);\n`,
    );
    expect(() =>
      invariantNoAutonomousPath([
        ...readDomainSources(),
        { name: 'feedback-conversion-service.ts (MUTATED: autonomous loop)', src: mutatedService },
      ]),
    ).toThrow('INVARIANT (no autonomous path)');
  });

  it('KILL 7 — removing architectureVersionId from the decision-record identity: removing the boundary makes the cross-version record-independence invariant test FAIL (the PR #107 architect-review blocker)', async () => {
    // GREEN — the real production module holds the invariant:
    await invariantCrossVersionRecordIndependence(DefaultFeedbackConversionService);
    // RED — the record identity derived WITHOUT the architecture version
    // (the exact defect from the architect review): the same signal under
    // version B collides on version A's record identity — the second
    // version's conversion FAILS on the record log (or would converge on
    // the WRONG record), which the invariant test rejects:
    const mod = await loadMutantModule('kill-7-versionless-record-id', FC_SERVICE, (src) =>
      applyOnce(
        'KILL 7',
        src,
        '      recordId: deriveConversionRecordId(\n        conversionKey,\n        architectureVersionId,\n        signal.signalId,',
        '      recordId: deriveConversionRecordId(\n        conversionKey,\n        \'\',\n        signal.signalId,',
      ),
    );
    await expect(
      invariantCrossVersionRecordIndependence((mod as { DefaultFeedbackConversionService: ServiceCtor }).DefaultFeedbackConversionService),
    ).rejects.toThrow('INVARIANT (cross-version record independence)');
  });
});

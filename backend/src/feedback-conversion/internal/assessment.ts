/**
 * WORK-068 — the deterministic conversion assessment.
 *
 * Interprets the signal's RECORDED evidence (the WORK-067 record — severity,
 * occurrences, environments, sources) against the existing backlog state
 * (read through the `/work-items` authority). NEVER invents evidence: no
 * release identities, no deployment identities, no GitHub state, no
 * validation state, no provider health, no business outcomes, no priority
 * from undocumented heuristics. Every factor cites recorded evidence.
 */
import type {
  BacklogContext,
  ConversionAssessment,
  ConversionFactor,
  EngineeringSignalRecord,
} from '../types.js';

/** The deterministic severity interpretation (documented mapping — never a heuristic). */
export function interpretSeverity(
  severity: 'critical' | 'high' | 'medium' | 'low',
): string {
  switch (severity) {
    case 'critical':
      return 'critical — the latest observed occurrence is a critical failure: conversion treats the problem as immediately actionable governed work';
    case 'high':
      return 'high — the latest observed occurrence is a high-severity failure: conversion treats the problem as actionable governed work';
    case 'medium':
      return 'medium — the latest observed occurrence is a medium-severity failure: conversion records the problem as governed work at standard priority';
    case 'low':
      return 'low — the latest observed occurrence is a low-severity failure: conversion records the problem as governed work at background priority';
  }
}

/** Derive the distinct environments spanned by the signal's occurrences. */
function distinctEnvironments(signal: EngineeringSignalRecord): string[] {
  // WORK-067's signal identity carries ONE environment per signal; distinct
  // environments across the logical problem are observed through the
  // contributing signals of the SAME conversion key (multi-environment
  // convergence). The per-signal environment set is the signal's own scope.
  return [signal.environmentId];
}

/**
 * Derive the ISO-8601 duration between the first and last observation (the
 * recorded recurrence span — never extrapolated).
 */
export function deriveRecurrenceSpan(
  firstObservedAt: string,
  lastObservedAt: string,
): string {
  const first = Date.parse(firstObservedAt);
  const last = Date.parse(lastObservedAt);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) {
    return 'PT0S';
  }
  const ms = last - first;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const hh = String(hours % 24).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `P${days}DT${hh}H${mm}M${ss}S`;
}

/**
 * Assemble the deterministic assessment. The backlog context is supplied by
 * the orchestrator (read through the authority) — the assessment NEVER
 * reads stores itself.
 */
export function assessSignal(
  signal: EngineeringSignalRecord,
  backlogContext: BacklogContext,
): ConversionAssessment {
  const factors: ConversionFactor[] = [];

  // Factor 1 — the signal severity (recorded evidence).
  factors.push({
    kind: 'signal-severity',
    detail: `latest recorded occurrence severity is '${signal.latestSeverity}' (WORK-067 deterministic latest-occurrence ordering)`,
  });

  // Factor 2 — recurrence (the recorded occurrence history).
  const occurrenceCount = signal.occurrences.length;
  const recurrenceSpan = deriveRecurrenceSpan(
    signal.firstObservedAt,
    signal.lastObservedAt,
  );
  factors.push({
    kind: 'recurrence',
    detail: `${occurrenceCount} recorded occurrence(s) over ${recurrenceSpan} (first ${signal.firstObservedAt}, last ${signal.lastObservedAt})`,
  });

  // Factor 3 — blast radius: the environments spanned.
  const environments = distinctEnvironments(signal);
  factors.push({
    kind: 'blast-radius-environments',
    detail: `the signal is observed in environment '${signal.environmentId}' (the logical problem's environment scope enters the assessment's blast radius; the conversion identity is deliberately environment-independent — the same logical failure across environments converges on ONE Work Item)`,
  });

  // Factor 4 — blast radius: the distinct sources.
  const sources = [...signal.sources];
  factors.push({
    kind: 'blast-radius-sources',
    detail: `${sources.length} distinct source(s): ${sources.join(', ') || '(none recorded)'}`,
  });

  // Factor 5 — the existing backlog state (read through the authority).
  factors.push({
    kind: 'backlog-context',
    detail: `the target architecture version currently records ${backlogContext.openItemCount} open and ${backlogContext.completedItemCount} completed Work Item(s) (read through the /work-items authority)`,
  });

  const severityInterpretation = interpretSeverity(signal.latestSeverity);

  const reasoning = [
    `Assessment of Engineering Signal ${signal.signalId} (tenant ${signal.tenantId}, project ${signal.projectId}, environment ${signal.environmentId}, logical failure key '${signal.logicalFailureKey}'):`,
    `severity — ${severityInterpretation};`,
    `recurrence — ${occurrenceCount} occurrence(s) over ${recurrenceSpan};`,
    `blast radius — environment ${signal.environmentId}, sources [${sources.join(', ')}];`,
    `backlog — ${backlogContext.openItemCount} open / ${backlogContext.completedItemCount} completed Work Item(s) in the target version.`,
    `Every input above is recorded evidence from the WORK-067 signal record or the /work-items authority read — nothing is inferred from timestamps alone, commits, URLs, GitHub state, or provider health.`,
  ].join(' ');

  return {
    signalId: signal.signalId,
    signalFingerprint: signal.identityFingerprint,
    tenantId: signal.tenantId,
    projectId: signal.projectId,
    environments,
    sources,
    occurrenceCount,
    firstObservedAt: signal.firstObservedAt,
    lastObservedAt: signal.lastObservedAt,
    latestSeverity: signal.latestSeverity,
    severityInterpretation,
    recurrenceSpan,
    backlogContext,
    factors,
    reasoning,
  };
}

/**
 * Derive the backlog context from the existing Work Items (read through the
 * authority — the ONLY backlog evidence the assessment uses).
 */
export function deriveBacklogContext(
  existingItems: ReadonlyArray<{
    completed: boolean;
    metadata: Record<string, unknown>;
  }>,
): BacklogContext {
  let openItemCount = 0;
  let completedItemCount = 0;
  const openConversionSeverities: Record<string, number> = {};
  for (const item of existingItems) {
    if (item.completed) {
      completedItemCount++;
      continue;
    }
    openItemCount++;
    const feedback = (
      item.metadata as { feedbackConversion?: { assessment?: { latestSeverity?: string } } }
    )?.feedbackConversion;
    const severity = feedback?.assessment?.latestSeverity;
    if (typeof severity === 'string') {
      openConversionSeverities[severity] = (openConversionSeverities[severity] ?? 0) + 1;
    }
  }
  return { openItemCount, completedItemCount, openConversionSeverities };
}

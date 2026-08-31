/**
 * WORK-068 — the in-memory conversion-record repository (the PORT adapter).
 *
 * The WORK-064/066/067 port precedent: NO schema migration is authorized
 * (`migrations: []`); the in-memory adapter is the composed implementation
 * and the durable decision-log binding point stays a documented future ACR
 * at the same port. The keyed-uniqueness contract (recordId =
 * deterministic (conversionKey, architectureVersionId, signalId, decision))
 * mirrors the PostgreSQL PRIMARY KEY discipline — the real-PG two-actor
 * integration suite proves the contract against a test-schema table
 * implementing the same port.
 */
import type {
  ConversionRecord,
  FeedbackConversionRecordRepository,
} from '../types.js';
import { FeedbackConversionError } from '../types.js';

interface StoredEntry {
  readonly record: ConversionRecord;
}

export class InMemoryFeedbackConversionRecordRepository
  implements FeedbackConversionRecordRepository
{
  private readonly byRecordId = new Map<string, StoredEntry>();
  private readonly byConversionKey = new Map<string, StoredEntry[]>();
  private readonly byProject = new Map<string, StoredEntry[]>();

  async append(record: ConversionRecord): Promise<ConversionRecord> {
    const existing = this.byRecordId.get(record.recordId);
    if (existing) {
      // Idempotent convergence: the same (conversionKey,
      // architectureVersionId, signalId, decision) identity re-appended
      // returns the STORED record — re-delivery never duplicates the log.
      // A DIFFERENT payload under the same record identity is a typed
      // conflict (fail closed — never silently overwritten). The
      // architectureVersionId comparison is defense in depth: the recordId
      // derivation already scopes by version, so a cross-version append
      // carries a DIFFERENT recordId and never reaches this branch — but if
      // a recordId ever collided across versions, the payload check still
      // refuses to converge it (the PR #107 architect-review fix).
      if (
        existing.record.decision === record.decision &&
        existing.record.architectureVersionId === record.architectureVersionId &&
        existing.record.workItemId === record.workItemId &&
        existing.record.workItemHumanId === record.workItemHumanId
      ) {
        return existing.record;
      }
      throw new FeedbackConversionError(
        'FEEDBACK_CONVERSION_RECORD_CONFLICT',
        `record ${record.recordId} already stored with a different decision (stored '${existing.record.decision}' → appended '${record.decision}') — the decision log is append-only and never silently rewritten`,
      );
    }
    const entry: StoredEntry = { record };
    this.byRecordId.set(record.recordId, entry);
    const keyList = this.byConversionKey.get(record.conversionKey) ?? [];
    keyList.push(entry);
    this.byConversionKey.set(record.conversionKey, keyList);
    const projectList = this.byProject.get(record.projectId) ?? [];
    projectList.push(entry);
    this.byProject.set(record.projectId, projectList);
    return record;
  }

  async listForConversion(conversionKey: string): Promise<readonly ConversionRecord[]> {
    return (this.byConversionKey.get(conversionKey) ?? []).map((e) => e.record);
  }

  async listForProject(projectId: string): Promise<readonly ConversionRecord[]> {
    return (this.byProject.get(projectId) ?? []).map((e) => e.record);
  }
}

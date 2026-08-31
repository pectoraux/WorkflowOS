/**
 * WORK-068 — the internal barrel for the feedback-conversion domain.
 */
export { deriveConversionIdentity, deriveConversionRecordId, deriveProposalTitle, deriveProposalObjective, deriveArchitectureImpact } from './conversion-identity.js';
export { assessSignal, deriveBacklogContext, interpretSeverity, deriveRecurrenceSpan } from './assessment.js';
export { deriveConversionPriority } from './priority.js';
export { InMemoryFeedbackConversionRecordRepository } from './in-memory-conversion-record-repository.js';
export {
  DefaultFeedbackConversionService,
  type DefaultFeedbackConversionServiceDeps,
} from './feedback-conversion-service.js';

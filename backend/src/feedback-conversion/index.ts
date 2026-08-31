/**
 * WORK-068 — the feedback-conversion domain public barrel.
 *
 * Canonical name: feedback-conversion (the application-layer pattern — NOT
 * an 18th frozen module). The governed bridge from WORK-067 advisory
 * Engineering Signals into PROPOSED Work Items that enter the EXISTING
 * `/work-items` authority through its existing public intake.
 *
 * Consumers may import ONLY from this barrel (+ types.ts). Files under
 * `internal/` are private to this domain; cross-domain imports of
 * `internal/` are forbidden and enforced statically.
 */
export {
  CONVERSION_DECISION_STATUSES,
  CONVERSION_PRIORITY_RANKS,
  CONVERSION_FACTOR_KINDS,
  FEEDBACK_CONVERSION_ERROR_CODES,
  FeedbackConversionError,
} from './types.js';
export type {
  ConversionDecisionStatus,
  ConversionPriorityRank,
  ConversionFactorKind,
  FeedbackConversionErrorCode,
  ConversionIdentity,
  ConversionIdentityInput,
  ConversionFactor,
  ConversionAssessment,
  BacklogContext,
  ConversionPriority,
  ContributingSignal,
  FeedbackConversionMetadata,
  ConversionRecord,
  FeedbackConversionRecordRepository,
  ConvertSignalInput,
  FeedbackConversionContext,
  EngineeringSignalReader,
  EngineeringSignalRecord,
  WorkItemIntake,
  WorkItemRecord,
  ArchitectureVersionReader,
  ArchitectureReader,
  ConversionResult,
  FeedbackConversionService,
} from './types.js';
export {
  DefaultFeedbackConversionService,
  InMemoryFeedbackConversionRecordRepository,
  deriveConversionIdentity,
  deriveConversionRecordId,
  deriveProposalTitle,
  deriveProposalObjective,
  deriveArchitectureImpact,
} from './internal/index.js';
export type { DefaultFeedbackConversionServiceDeps } from './internal/index.js';

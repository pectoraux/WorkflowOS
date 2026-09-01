/**
 * V2-003 — WorkflowIR types, vocabularies and frozen constants.
 *
 * WorkflowIR is the canonical, platform-neutral semantic representation of
 * one immutable WorkflowVersion (architecture constitution §2/§3). It is the
 * sole semantic source of truth for WorkflowOS workflows.
 *
 * Protocol-visible identifiers (execution classes, placement ids, the
 * capability namespace and the digest rule) come ONLY from the merged V2-001
 * contract: `spec/architecture/v2/V2-CTRL-003-protocol-registry.md` (+ `.json`).
 * The vocabulary constants below are pinned byte-for-byte against that
 * registry by tests/workflow-ir/ir-platform-neutrality.test.ts; no aliases
 * are introduced as alternate protocol meanings.
 *
 * Ownership boundaries (V2-003.md "Does not own"):
 * - NO repository/version persistence semantics (V2-002);
 * - NO Node/Capability advertisement or placement resolution (V2-004) —
 *   capability/placement REQUIREMENTS are data only;
 * - NO execution/runtime, teaching, compiler or marketplace semantics.
 */

/** Current WorkflowIR schema version interpreted by this library. */
export const WORKFLOW_IR_SCHEMA_VERSION = 1;

/** Every schema version this library can interpret. */
export const SUPPORTED_WORKFLOW_IR_SCHEMA_VERSIONS: readonly number[] = [1];

/**
 * Canonical execution classes (V2-CTRL-003 `executionClasses`).
 * Distinct and non-interchangeable: deterministic/API, agentic/computer-use,
 * human, subworkflow.
 */
export const WORKFLOW_IR_EXECUTION_CLASSES = [
  'deterministic_api',
  'agentic_computer_use',
  'human',
  'subworkflow',
] as const;

/** Canonical placement/locality ids (V2-CTRL-003 `placement`). */
export const WORKFLOW_IR_PLACEMENT_IDS = [
  'device_local',
  'device_preferred',
  'cloud_allowed',
  'cloud_preferred',
  'cloud_required',
  'any_supported_node',
] as const;

/**
 * Closed, platform-neutral value-type tag set (V2-001 protocol input/output
 * model: scalars, structured values, references — no platform SDK concepts
 * like DOM nodes, screenshots or selectors).
 */
export const WORKFLOW_IR_VALUE_TYPE_TAGS = [
  'string',
  'number',
  'boolean',
  'json',
  'object_ref',
  'secret_ref',
  'user_ref',
  'device_ref',
] as const;

/** Digest algorithm (V2-CTRL-003 `digest.algorithm`): SHA-256 over canonical JSON. */
export const WORKFLOW_IR_DIGEST_ALGORITHM = 'SHA-256';

/**
 * The canonical capability identifiers from V2-CTRL-003 (the merged V2-001
 * registry). The registry is extensible: a well-formed, namespaced identifier
 * outside this list is accepted as a genuinely new canonical capability;
 * known non-canonical aliases are rejected with CAPABILITY_ALIAS.
 */
export const WORKFLOW_IR_CANONICAL_CAPABILITIES: readonly string[] = [
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.observe',
  'browser.download',
  'browser.upload',
  'filesystem.read',
  'filesystem.write',
  'application.open',
  'application.observe',
  'application.interact',
  'screen.observe',
  'ui.inspect',
  'ui.click',
  'ui.type',
  'phone.call.observe',
  'phone.call.identify',
  'phone.call.answer',
  'phone.call.reject',
  'phone.call.end',
  'messaging.observe',
  'messaging.read',
  'messaging.send',
  'contacts.read',
  'contacts.search',
  'contacts.create',
  'notifications.observe',
  'microphone.capture',
  'speech.synthesis',
  'camera.capture',
  'location.read',
  'spreadsheet.read',
  'spreadsheet.edit',
  'social.post.observe',
  'social.post.publish',
  'social.engagement.observe',
  'workflow.execute',
  'workflow.pause',
  'workflow.resume',
  'workflow.cancel',
  'workflow.deploy',
  'workflow.observe',
  'github.repository.read',
  'github.pull_request.create',
  'github.pull_request.merge',
];

/**
 * Documented NON-canonical capability aliases (V2-CTRL-003: "aliasesForbidden").
 * This table exists ONLY to fail closed with the canonical suggestion —
 * aliases are never accepted as alternate protocol meanings (registry
 * conformance rule 4: discrimination tests prevent accidental aliasing).
 */
export const WORKFLOW_IR_CAPABILITY_ALIASES: Readonly<Record<string, string>> = {
  'messages.send': 'messaging.send',
  'phone.answer_call': 'phone.call.answer',
  'calls.answer': 'phone.call.answer',
  'selenium.click': 'browser.click',
};

export type WorkflowIRExecutionClass = (typeof WORKFLOW_IR_EXECUTION_CLASSES)[number];
export type WorkflowIRPlacementId = (typeof WORKFLOW_IR_PLACEMENT_IDS)[number];
export type WorkflowIRValueTypeTag = (typeof WORKFLOW_IR_VALUE_TYPE_TAGS)[number];
export type WorkflowIRLiteralType = 'string' | 'number' | 'boolean' | 'json';

/**
 * Typed protocol value. Scalars and opaque references carry a tag; composite
 * values are `list` (ordered collection) or `record` (string-keyed map) of an
 * element type. Types are compared structurally and deeply — there is no
 * silent coercion between distinct types.
 */
export type WorkflowIRValueType =
  | WorkflowIRValueTypeTag
  | { list: WorkflowIRValueType }
  | { record: WorkflowIRValueType };

/** A typed data port (workflow interface or node input/output). */
export interface WorkflowIRPort {
  id: string;
  type: WorkflowIRValueType;
}

/** Where a workflow author's meaning came from (provenance is metadata, not raw capture). */
export type WorkflowIRProvenanceOrigin = 'authored' | 'compiled';

/**
 * Provenance records HOW the WorkflowIR came to exist. Raw demonstrations,
 * recordings and prompts are compilation INPUTS (V2-007), never embeddable
 * content — only opaque textual source references are allowed.
 */
export interface WorkflowIRProvenance {
  origin: WorkflowIRProvenanceOrigin;
  generator?: string;
  sourceReferences?: string[];
}

/** Placement constraints are data (a correctness constraint, not a resolution). */
export interface WorkflowIRPlacement {
  locality: WorkflowIRPlacementId;
  disallowed?: string[];
}

/** Capability/placement REQUIREMENTS derived from the workflow's meaning. */
export interface WorkflowIRRequirements {
  capabilities: string[];
  placement: WorkflowIRPlacement;
}

/**
 * An explicit dependency on another immutable WorkflowVersion (subworkflow
 * steps). The version reference is opaque — version identity semantics are
 * V2-002's authority, not WorkflowIR's.
 */
export interface WorkflowIRDependency {
  id: string;
  workflowVersionId: string;
}

/** Control-flow edge kinds. The closed set of control semantics. */
export type WorkflowIREdgeKind =
  | 'on_success'
  | 'on_failure'
  | 'on_approval'
  | 'on_rejection'
  | 'on_case'
  | 'on_default';

export interface WorkflowIREdge {
  from: string;
  to: string;
  kind: WorkflowIREdgeKind;
  /** Only meaningful (and only allowed) on `on_case` edges. */
  case?: string;
}

/** Decision case condition over the decision's single scalar input. */
export type WorkflowIRCondition =
  | { kind: 'equals'; value: string | number | boolean }
  | { kind: 'exists' };

export interface WorkflowIRDecisionCase {
  id: string;
  condition: WorkflowIRCondition;
}

/** Failure policy for a step (retry count). */
export interface WorkflowIRFailurePolicy {
  retry: number;
}

/**
 * A workflow step — the executable unit. Which fields are legal depends on
 * the execution class:
 * - `deterministic_api` / `agentic_computer_use` REQUIRE `capability`;
 * - `subworkflow` REQUIRES `dependency` and forbids `capability`;
 * - `human` forbids `capability`; `requestApproval` makes it an approval gate;
 * - steps with `requestApproval` may not carry a failure policy.
 *
 * The `?: never` fields exist on the other node kinds only so the union type
 * admits uniform property access; the validator rejects them as UNKNOWN_FIELD
 * whenever they appear on a node that does not own them.
 */
export interface WorkflowIRStepNode {
  kind: 'step';
  id: string;
  instruction: string;
  executionClass: WorkflowIRExecutionClass;
  capability?: string;
  dependency?: string;
  inputs: WorkflowIRPort[];
  outputs: WorkflowIRPort[];
  pauseSafe?: boolean;
  requestApproval?: boolean;
  failure?: WorkflowIRFailurePolicy;
  cases?: never;
  outcome?: never;
}

export interface WorkflowIRDecisionNode {
  kind: 'decision';
  id: string;
  /** Exactly zero or one input port; decisions have no outputs. */
  inputs?: WorkflowIRPort[];
  cases: WorkflowIRDecisionCase[];
  instruction?: never;
  executionClass?: never;
  capability?: never;
  dependency?: never;
  outputs?: never;
  pauseSafe?: never;
  requestApproval?: never;
  failure?: never;
  outcome?: never;
}

export interface WorkflowIREndNode {
  kind: 'end';
  id: string;
  /** Only a `failure` outcome is explicit; the default (success) is omitted. */
  outcome?: 'failure';
  instruction?: never;
  executionClass?: never;
  capability?: never;
  dependency?: never;
  inputs?: never;
  outputs?: never;
  pauseSafe?: never;
  requestApproval?: never;
  failure?: never;
  cases?: never;
}

export interface WorkflowIRStartNode {
  kind: 'start';
  id: string;
  instruction?: never;
  executionClass?: never;
  capability?: never;
  dependency?: never;
  inputs?: never;
  outputs?: never;
  pauseSafe?: never;
  requestApproval?: never;
  failure?: never;
  cases?: never;
  outcome?: never;
}

export type WorkflowIRNode =
  | WorkflowIRStepNode
  | WorkflowIRDecisionNode
  | WorkflowIREndNode
  | WorkflowIRStartNode;

/** An inline literal value (only scalar/json literals exist — never secret material). */
export interface WorkflowIRLiteral {
  type: WorkflowIRLiteralType;
  value: unknown;
}

export type WorkflowIRBindingSource =
  | { kind: 'workflow_input'; input: string }
  | { kind: 'node_output'; node: string; port: string }
  | { kind: 'literal'; literal: WorkflowIRLiteral };

export type WorkflowIRBindingTarget =
  | { kind: 'node_input'; node: string; port: string }
  | { kind: 'workflow_output'; output: string };

export interface WorkflowIRDataBinding {
  source: WorkflowIRBindingSource;
  target: WorkflowIRBindingTarget;
}

/**
 * The WorkflowIR document: the complete semantic content of one
 * WorkflowVersion.
 *
 * The form returned by `validateWorkflowIR` / `deserializeWorkflowIR` is the
 * CANONICAL form (declared sets sorted and de-duplicated, schema defaults
 * omitted) and is deeply frozen at runtime — an immutable semantic object.
 */
export interface WorkflowIR {
  schemaVersion: number;
  nodes: WorkflowIRNode[];
  edges: WorkflowIREdge[];
  dataBindings: WorkflowIRDataBinding[];
  inputs: WorkflowIRPort[];
  outputs: WorkflowIRPort[];
  dependencies: WorkflowIRDependency[];
  requirements: WorkflowIRRequirements;
  provenance: WorkflowIRProvenance;
}

/**
 * The authoring-side view of a WorkflowIR document (mutable arrays/fields for
 * test and authoring ergonomics). The canonical form produced by this library
 * is frozen at runtime regardless of the static type.
 */
export type DeepMutableWorkflowIR = WorkflowIR;

/** Options controlling schema-version negotiation during validation. */
export interface WorkflowIRValidationOptions {
  /** The consumer's declared supported schema versions (defaults to this library's). */
  supportedSchemaVersions?: number[];
}

/** Result of protocol-level schema-version negotiation. */
export type WorkflowIRVersionNegotiation =
  | { status: 'compatible'; mode: 'exact' }
  | { status: 'compatible'; mode: 'backward' }
  | { status: 'incompatible'; reason: 'producer_newer_than_consumer' }
  | { status: 'incompatible'; reason: 'invalid_consumer_set' };

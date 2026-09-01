import { fail } from './errors.js';
import { isPlainObject, isCanonicalJsonSafe } from './canonical-json.js';
import { checkSchemaVersionAcceptable } from './version.js';
import {
  WORKFLOW_IR_EXECUTION_CLASSES,
  WORKFLOW_IR_PLACEMENT_IDS,
  WORKFLOW_IR_VALUE_TYPE_TAGS,
  WORKFLOW_IR_CANONICAL_CAPABILITIES,
  WORKFLOW_IR_CAPABILITY_ALIASES,
} from '../types.js';
import type {
  WorkflowIR,
  WorkflowIRNode,
  WorkflowIRStepNode,
  WorkflowIRDecisionNode,
  WorkflowIRPort,
  WorkflowIRValidationOptions,
  WorkflowIREdge,
  WorkflowIRDataBinding,
  WorkflowIRBindingSource,
  WorkflowIRBindingTarget,
  WorkflowIRValueType,
  WorkflowIRDependency,
  WorkflowIRProvenance,
} from '../types.js';

/**
 * V2-003 — WorkflowIR structural and semantic validation.
 *
 * Validation is a strictly ordered fail-closed pipeline. Every phase must
 * pass before the next runs, so each invalid document is rejected with
 * exactly one frozen reason:
 *
 *   0. NOT_A_WORKFLOW_IR     — the value is not an object shaped like IR at
 *                              all (prompts, recordings, traces, teaching
 *                              sessions, compiled artifacts — constitution §3);
 *   1. top-level shape       — MISSING_FIELD / UNKNOWN_FIELD / INVALID_FIELD /
 *                              INVALID_SCHEMA_VERSION / UNSUPPORTED_SCHEMA_VERSION;
 *   2. nodes                 — per-kind field whitelists, identifiers, ports,
 *                              execution-class shape rules, decisions, conditions;
 *   3. dependencies          — declared ↔ used, opaque version references;
 *   4. provenance            — origin, generator, opaque source references;
 *   5. edges + graph         — endpoints, edge semantics per source kind,
 *                              start/end topology, unambiguous control counts,
 *                              reachability, acyclicity;
 *   6. data bindings         — endpoint integrity, typed sources/targets,
 *                              literals, exactly-once coverage;
 *   7. requirements          — registry vocabulary, placement consistency,
 *                              capability set agrees with the derived set;
 *   8. canonicalization      — the returned object is the deeply frozen
 *                              canonical form (declared sets sorted and
 *                              de-duplicated, schema defaults omitted).
 */

type Loose = Record<string, unknown>;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const SOURCE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKFLOW_VERSION_REF_PATTERN = /^[a-z0-9][a-z0-9._@:-]{0,127}$/;

const TOP_LEVEL_FIELDS = [
  'schemaVersion',
  'nodes',
  'edges',
  'dataBindings',
  'inputs',
  'outputs',
  'dependencies',
  'requirements',
  'provenance',
] as const;

const EDGE_KINDS = ['on_success', 'on_failure', 'on_approval', 'on_rejection', 'on_case', 'on_default'];
const NODE_KINDS = ['start', 'step', 'decision', 'end'];
const LITERAL_TYPES = ['string', 'number', 'boolean', 'json'];
const SCALAR_CONDITION_TAGS = ['string', 'number', 'boolean'];

const STEP_FIELDS = new Set([
  'kind', 'id', 'instruction', 'executionClass', 'capability', 'dependency',
  'inputs', 'outputs', 'pauseSafe', 'requestApproval', 'failure',
]);
const DECISION_FIELDS = new Set(['kind', 'id', 'inputs', 'outputs', 'cases']);
const END_FIELDS = new Set(['kind', 'id', 'outcome']);
const START_FIELDS = new Set(['kind', 'id']);

const MAX_FAILURE_RETRY = 10;

/** Context shared across validation phases. */
interface ValidationContext {
  nodeById: Map<string, Loose>;
  nodeOrder: string[];
  stepInputPorts: Map<string, Map<string, Loose>>;
  stepOutputPorts: Map<string, Map<string, Loose>>;
  decisionInputPorts: Map<string, Map<string, Loose>>;
  decisionCases: Map<string, Loose[]>;
  startId: string;
  endIds: Set<string>;
  workflowInputs: Map<string, Loose>;
  workflowOutputs: Map<string, Loose>;
  dependencyIds: Set<string>;
  derivedCapabilities: Set<string>;
}

/**
 * Validate a WorkflowIR document and return its deeply frozen canonical form.
 * Throws WorkflowIRError on any invalid structure or semantics.
 */
export function validateWorkflowIR(
  value: unknown,
  options?: WorkflowIRValidationOptions,
): WorkflowIR {
  if (!isPlainObject(value)) {
    fail(
      'NOT_A_WORKFLOW_IR',
      `expected a WorkflowIR object, got ${describeValue(value)} — prompts, recordings, traces, model memory, teaching sessions, compiled artifacts and marketplace listings are not WorkflowIR (constitution §3)`,
    );
  }
  const doc = value as Loose;

  // ---- phase 1: top-level shape -------------------------------------------
  const presentKeys = Object.keys(doc);
  const presentRequired = TOP_LEVEL_FIELDS.filter((field) => field in doc);
  if (presentRequired.length === 0) {
    fail(
      'NOT_A_WORKFLOW_IR',
      'the document has none of the required WorkflowIR fields — it is not a WorkflowIR',
    );
  }
  const missing = TOP_LEVEL_FIELDS.filter((field) => !(field in doc));
  if (missing.length > 0) {
    fail('MISSING_FIELD', `missing required field(s): ${missing.join(', ')}`);
  }
  const unknownTopLevel = presentKeys.filter((key) => !(TOP_LEVEL_FIELDS as readonly string[]).includes(key));
  if (unknownTopLevel.length > 0) {
    fail(
      'UNKNOWN_FIELD',
      `unknown top-level field(s): ${unknownTopLevel.join(', ')} — repository/marketplace metadata is not part of the IR (registry digest rules)`,
    );
  }

  const schemaVersion = doc.schemaVersion;
  if (
    typeof schemaVersion !== 'number' ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion <= 0 ||
    Object.is(schemaVersion, -0)
  ) {
    fail(
      'INVALID_SCHEMA_VERSION',
      `schemaVersion must be a positive integer, got ${String(schemaVersion)}`,
    );
  }
  checkSchemaVersionAcceptable(schemaVersion, options?.supportedSchemaVersions);

  for (const field of ['nodes', 'edges', 'dataBindings', 'inputs', 'outputs', 'dependencies']) {
    if (!Array.isArray(doc[field])) {
      fail('INVALID_FIELD', `${field} must be an array, got ${describeValue(doc[field])}`);
    }
  }
  if (!isPlainObject(doc.requirements)) {
    fail('INVALID_FIELD', `requirements must be an object, got ${describeValue(doc.requirements)}`);
  }
  if (!isPlainObject(doc.provenance)) {
    fail('INVALID_FIELD', `provenance must be an object, got ${describeValue(doc.provenance)}`);
  }

  const ctx: ValidationContext = {
    nodeById: new Map(),
    nodeOrder: [],
    stepInputPorts: new Map(),
    stepOutputPorts: new Map(),
    decisionInputPorts: new Map(),
    decisionCases: new Map(),
    startId: '',
    endIds: new Set(),
    workflowInputs: new Map(),
    workflowOutputs: new Map(),
    dependencyIds: new Set(),
    derivedCapabilities: new Set(),
  };

  // ---- phase 2: nodes ------------------------------------------------------
  (doc.nodes as unknown[]).forEach((rawNode, index) => {
    if (!isPlainObject(rawNode)) {
      fail('INVALID_FIELD', `nodes[${index}] must be an object, got ${describeValue(rawNode)}`);
    }
    validateNode(rawNode, index, ctx);
  });

  validateInterface(doc.inputs as unknown[], 'inputs', ctx.workflowInputs);
  validateInterface(doc.outputs as unknown[], 'outputs', ctx.workflowOutputs);

  // ---- phase 3: dependencies ----------------------------------------------
  validateDependencies(doc.dependencies as unknown[], ctx);

  // ---- phase 4: provenance -------------------------------------------------
  validateProvenance(doc.provenance as Loose);

  // ---- phase 5: edges + control graph --------------------------------------
  validateGraph(doc.edges as unknown[], ctx);

  // ---- phase 6: data bindings ----------------------------------------------
  validateDataBindings(doc.dataBindings as unknown[], ctx);

  // ---- phase 7: requirements -----------------------------------------------
  validateRequirements(doc.requirements as Loose, ctx);

  // ---- phase 8: canonical form ---------------------------------------------
  return buildCanonicalForm(doc as Loose, ctx);
}

// ---------------------------------------------------------------------------
// phase 2 helpers
// ---------------------------------------------------------------------------

function validateNode(rawNode: Loose, index: number, ctx: ValidationContext): void {
  const kind = rawNode.kind;
  if (typeof kind !== 'string' || !NODE_KINDS.includes(kind)) {
    fail('INVALID_FIELD', `nodes[${index}].kind must be one of ${NODE_KINDS.join('|')}`);
  }
  const id = rawNode.id;
  if (typeof id !== 'string' || !IDENTIFIER_PATTERN.test(id)) {
    fail(
      'INVALID_NODE_ID',
      `nodes[${index}].id must be a lowercase identifier matching ^[a-z][a-z0-9_]{0,63}$, got ${JSON.stringify(String(id))}`,
    );
  }
  if (ctx.nodeById.has(id)) {
    fail('DUPLICATE_NODE_ID', `duplicate node id "${id}"`);
  }
  ctx.nodeById.set(id, rawNode);
  ctx.nodeOrder.push(id);

  switch (kind) {
    case 'step':
      return validateStepNode(rawNode, id, ctx);
    case 'decision':
      return validateDecisionNode(rawNode, id, ctx);
    case 'end':
      return validateEndNode(rawNode, id, ctx);
    case 'start':
      return validateStartNode(rawNode, id, ctx);
  }
}

function assertNoUnknownFields(node: Loose, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) {
      fail('UNKNOWN_FIELD', `${where} declares unknown field "${key}" (fail closed — no silent extension)`);
    }
  }
}

function requireFields(node: Loose, fields: string[], where: string): void {
  for (const field of fields) {
    if (!(field in node)) {
      fail('MISSING_FIELD', `${where} is missing required field "${field}"`);
    }
  }
}

function validateStepNode(node: Loose, id: string, ctx: ValidationContext): void {
  assertNoUnknownFields(node, STEP_FIELDS, `step "${id}"`);
  requireFields(node, ['instruction', 'executionClass', 'inputs', 'outputs'], `step "${id}"`);

  const instruction = node.instruction;
  if (typeof instruction !== 'string' || instruction.trim().length === 0) {
    fail('INVALID_INSTRUCTION', `step "${id}" instruction must be a non-empty string`);
  }

  const executionClass = node.executionClass;
  if (
    typeof executionClass !== 'string' ||
    !WORKFLOW_IR_EXECUTION_CLASSES.includes(executionClass as (typeof WORKFLOW_IR_EXECUTION_CLASSES)[number])
  ) {
    fail(
      'INVALID_EXECUTION_CLASS',
      `step "${id}" executionClass must be one of ${WORKFLOW_IR_EXECUTION_CLASSES.join('|')} (V2-CTRL-003), got ${JSON.stringify(String(executionClass))}`,
    );
  }

  // capability / dependency presence rules per execution class
  if (node.capability !== undefined) {
    validateCapabilityIdentifier(node.capability, `step "${id}" capability`);
  }
  if (node.dependency !== undefined) {
    if (typeof node.dependency !== 'string' || !IDENTIFIER_PATTERN.test(node.dependency)) {
      fail(
        'INVALID_DEPENDENCY',
        `step "${id}" dependency must be a lowercase identifier, got ${JSON.stringify(String(node.dependency))}`,
      );
    }
  }
  if (executionClass === 'deterministic_api' || executionClass === 'agentic_computer_use') {
    if (node.capability === undefined) {
      fail(
        'INVALID_NODE_SHAPE',
        `step "${id}" (${executionClass}) requires a capability`,
      );
    }
  } else if (node.capability !== undefined) {
    fail(
      'INVALID_NODE_SHAPE',
      `step "${id}" (${executionClass}) must not declare a capability`,
    );
  }
  if (executionClass === 'subworkflow') {
    if (node.dependency === undefined) {
      fail('INVALID_NODE_SHAPE', `subworkflow step "${id}" requires a dependency`);
    }
  } else if (node.dependency !== undefined) {
    fail(
      'INVALID_NODE_SHAPE',
      `step "${id}" (${executionClass}) must not declare a dependency (only subworkflow steps invoke dependencies)`,
    );
  }

  if (node.pauseSafe !== undefined && typeof node.pauseSafe !== 'boolean') {
    fail('INVALID_FIELD', `step "${id}" pauseSafe must be a boolean`);
  }
  if (node.requestApproval !== undefined && typeof node.requestApproval !== 'boolean') {
    fail('INVALID_FIELD', `step "${id}" requestApproval must be a boolean`);
  }
  if (node.requestApproval === true && executionClass !== 'human') {
    fail(
      'INVALID_NODE_SHAPE',
      `step "${id}" declares requestApproval but is not a human step (approval gates are human steps)`,
    );
  }
  if (node.failure !== undefined) {
    const failure = node.failure;
    if (!isPlainObject(failure)) {
      fail('INVALID_FIELD', `step "${id}" failure must be an object`);
    }
    assertNoUnknownFields(failure, new Set(['retry']), `step "${id}" failure`);
    const retry = failure.retry;
    if (
      typeof retry !== 'number' ||
      !Number.isInteger(retry) ||
      retry < 0 ||
      retry > MAX_FAILURE_RETRY
    ) {
      fail(
        'INVALID_FIELD',
        `step "${id}" failure.retry must be an integer between 0 and ${MAX_FAILURE_RETRY}`,
      );
    }
    if (node.requestApproval === true) {
      fail(
        'INVALID_NODE_SHAPE',
        `approval step "${id}" must not declare a failure policy (approval outcomes are decisions, not retries)`,
      );
    }
  }

  const inputPorts = collectPorts(node.inputs, `step "${id}" inputs`);
  const outputPorts = collectPorts(node.outputs, `step "${id}" outputs`);
  ctx.stepInputPorts.set(id, inputPorts);
  ctx.stepOutputPorts.set(id, outputPorts);
  if (typeof node.capability === 'string') {
    ctx.derivedCapabilities.add(node.capability);
  }
}

function validateDecisionNode(node: Loose, id: string, ctx: ValidationContext): void {
  assertNoUnknownFields(node, DECISION_FIELDS, `decision "${id}"`);
  requireFields(node, ['cases'], `decision "${id}"`);

  const inputs = node.inputs !== undefined ? node.inputs : [];
  if (!Array.isArray(inputs)) {
    fail('INVALID_DECISION', `decision "${id}" inputs must be an array`);
  }
  if (inputs.length > 1) {
    fail('INVALID_DECISION', `decision "${id}" must have at most one input port`);
  }
  const inputPorts = collectPorts(inputs, `decision "${id}" inputs`);

  const outputs = node.outputs !== undefined ? node.outputs : [];
  if (!Array.isArray(outputs) || outputs.length > 0) {
    fail('INVALID_DECISION', `decision "${id}" must not declare output ports`);
  }

  const cases = node.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    fail('INVALID_DECISION', `decision "${id}" must declare a non-empty case list`);
  }
  const seenCaseIds = new Set<string>();
  cases.forEach((rawCase, caseIndex) => {
    if (!isPlainObject(rawCase)) {
      fail('INVALID_DECISION', `decision "${id}" cases[${caseIndex}] must be an object`);
    }
    assertNoUnknownFields(rawCase, new Set(['id', 'condition']), `decision "${id}" cases[${caseIndex}]`);
    const caseId = rawCase.id;
    if (typeof caseId !== 'string' || !IDENTIFIER_PATTERN.test(caseId)) {
      fail(
        'INVALID_DECISION',
        `decision "${id}" cases[${caseIndex}].id must be a lowercase identifier`,
      );
    }
    if (seenCaseIds.has(caseId)) {
      fail('INVALID_DECISION', `decision "${id}" declares duplicate case id "${caseId}"`);
    }
    seenCaseIds.add(caseId);
    validateCondition(rawCase.condition, id, caseId, inputPorts);
  });

  ctx.decisionInputPorts.set(id, inputPorts);
  ctx.decisionCases.set(id, cases as Loose[]);
}

function validateCondition(
  rawCondition: unknown,
  decisionId: string,
  caseId: string,
  inputPorts: Map<string, Loose>,
): void {
  if (!isPlainObject(rawCondition)) {
    fail('INVALID_CONDITION', `decision "${decisionId}" case "${caseId}" condition must be an object`);
  }
  assertNoUnknownFields(
    rawCondition,
    new Set(['kind', 'value']),
    `decision "${decisionId}" case "${caseId}" condition`,
  );
  const kind = rawCondition.kind;
  if (kind === 'equals') {
    const value = rawCondition.value;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      fail(
        'INVALID_CONDITION',
        `decision "${decisionId}" case "${caseId}" equals condition requires a scalar value`,
      );
    }
    if (inputPorts.size !== 1) {
      fail(
        'INVALID_CONDITION',
        `decision "${decisionId}" case "${caseId}" equals condition requires exactly one scalar input port`,
      );
    }
    const input = [...inputPorts.values()][0]!;
    const inputType = input.type;
    if (
      typeof inputType !== 'string' ||
      !SCALAR_CONDITION_TAGS.includes(inputType)
    ) {
      fail(
        'INVALID_CONDITION',
        `decision "${decisionId}" case "${caseId}" equals condition requires a scalar (string|number|boolean) input, got ${JSON.stringify(String(inputType))}`,
      );
    }
    const valueTag =
      typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean';
    if (valueTag !== inputType) {
      fail(
        'INVALID_CONDITION',
        `decision "${decisionId}" case "${caseId}" equals value (${valueTag}) does not conform to the input type (${inputType})`,
      );
    }
    return;
  }
  if (kind === 'exists') {
    if ('value' in rawCondition) {
      fail(
        'INVALID_CONDITION',
        `decision "${decisionId}" case "${caseId}" exists condition must not declare a value`,
      );
    }
    return;
  }
  fail(
    'INVALID_CONDITION',
    `decision "${decisionId}" case "${caseId}" condition kind must be "equals" or "exists", got ${JSON.stringify(String(kind))}`,
  );
}

function validateEndNode(node: Loose, id: string, ctx: ValidationContext): void {
  assertNoUnknownFields(node, END_FIELDS, `end node "${id}"`);
  const outcome = node.outcome;
  if (outcome !== undefined && outcome !== 'failure') {
    fail(
      'INVALID_FIELD',
      `end node "${id}" outcome must be "failure" when present, got ${JSON.stringify(String(outcome))}`,
    );
  }
  ctx.endIds.add(id);
}

function validateStartNode(node: Loose, id: string, ctx: ValidationContext): void {
  assertNoUnknownFields(node, START_FIELDS, `start node "${id}"`);
  if (ctx.startId !== '') {
    fail('START_NODE_INVALID', `the graph declares more than one start node`);
  }
  ctx.startId = id;
}

function collectPorts(rawPorts: unknown, where: string): Map<string, Loose> {
  if (!Array.isArray(rawPorts)) {
    fail('INVALID_FIELD', `${where} must be an array`);
  }
  const ports = new Map<string, Loose>();
  rawPorts.forEach((rawPort, index) => {
    if (!isPlainObject(rawPort)) {
      fail('INVALID_FIELD', `${where}[${index}] must be an object`);
    }
    assertNoUnknownFields(rawPort, new Set(['id', 'type']), `${where}[${index}]`);
    const portId = rawPort.id;
    if (typeof portId !== 'string' || !IDENTIFIER_PATTERN.test(portId)) {
      fail(
        'INVALID_NODE_ID',
        `${where}[${index}].id must be a lowercase identifier, got ${JSON.stringify(String(portId))}`,
      );
    }
    if (ports.has(portId)) {
      fail('DUPLICATE_PORT_ID', `duplicate port id "${portId}" in ${where}`);
    }
    validateValueType(rawPort.type, `${where}[${index}].type`);
    ports.set(portId, rawPort);
  });
  return ports;
}

function validateValueType(type: unknown, where: string): void {
  if (typeof type === 'string') {
    if (!WORKFLOW_IR_VALUE_TYPE_TAGS.includes(type as (typeof WORKFLOW_IR_VALUE_TYPE_TAGS)[number])) {
      fail(
        'INVALID_FIELD',
        `${where} must be a canonical value type tag (${WORKFLOW_IR_VALUE_TYPE_TAGS.join('|')}) or a { list } / { record } composite, got ${JSON.stringify(type)}`,
      );
    }
    return;
  }
  if (isPlainObject(type)) {
    const keys = Object.keys(type);
    if (keys.length === 1 && keys[0] === 'list') {
      validateValueType(type.list, `${where}.list`);
      return;
    }
    if (keys.length === 1 && keys[0] === 'record') {
      validateValueType(type.record, `${where}.record`);
      return;
    }
  }
  fail(
    'INVALID_FIELD',
    `${where} must be a canonical value type tag or a { list } / { record } composite`,
  );
}

/** Validate a capability identifier: structure, alias, or extensible canonical name. */
function validateCapabilityIdentifier(value: unknown, where: string): void {
  if (typeof value !== 'string' || !CAPABILITY_PATTERN.test(value)) {
    fail(
      'INVALID_CAPABILITY',
      `${where} must be a lowercase, dot-separated namespaced identifier, got ${JSON.stringify(String(value))}`,
    );
  }
  const alias = WORKFLOW_IR_CAPABILITY_ALIASES[value];
  if (alias !== undefined) {
    fail(
      'CAPABILITY_ALIAS',
      `${where} "${value}" is a non-canonical alias — the canonical identifier is "${alias}" (V2-CTRL-003 forbids protocol-visible aliases)`,
    );
  }
  if (WORKFLOW_IR_CANONICAL_CAPABILITIES.includes(value)) return;
  // The registry is extensible: a well-formed identifier in a genuinely new
  // namespace is a new canonical capability, not an error.
}

function validateInterface(rawPorts: unknown[], where: string, into: Map<string, Loose>): void {
  const ports = collectPorts(rawPorts, where);
  for (const [portId, port] of ports) {
    into.set(portId, port);
  }
}

// ---------------------------------------------------------------------------
// phase 3 helpers
// ---------------------------------------------------------------------------

function validateDependencies(rawDependencies: unknown[], ctx: ValidationContext): void {
  rawDependencies.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      fail('INVALID_DEPENDENCY', `dependencies[${index}] must be an object`);
    }
    assertNoUnknownFields(raw, new Set(['id', 'workflowVersionId']), `dependencies[${index}]`);
    const id = raw.id;
    if (typeof id !== 'string' || !IDENTIFIER_PATTERN.test(id)) {
      fail(
        'INVALID_DEPENDENCY',
        `dependencies[${index}].id must be a lowercase identifier, got ${JSON.stringify(String(id))}`,
      );
    }
    const workflowVersionId = raw.workflowVersionId;
    if (
      typeof workflowVersionId !== 'string' ||
      !WORKFLOW_VERSION_REF_PATTERN.test(workflowVersionId)
    ) {
      fail(
        'INVALID_DEPENDENCY',
        `dependencies[${index}].workflowVersionId must be an opaque lowercase version reference, got ${JSON.stringify(String(workflowVersionId))}`,
      );
    }
    if (ctx.dependencyIds.has(id)) {
      fail('INVALID_DEPENDENCY', `duplicate dependency id "${id}"`);
    }
    ctx.dependencyIds.add(id);
  });

  // declared ↔ used cross-check with subworkflow steps
  const usedDependencies = new Set<string>();
  for (const [nodeId, node] of ctx.nodeById) {
    if (node.kind !== 'step' || node.executionClass !== 'subworkflow') continue;
    const dependency = node.dependency;
    if (typeof dependency !== 'string') continue; // shape errors already reported
    if (!ctx.dependencyIds.has(dependency)) {
      fail(
        'INVALID_DEPENDENCY',
        `subworkflow step "${nodeId}" references undeclared dependency "${dependency}"`,
      );
    }
    usedDependencies.add(dependency);
  }
  for (const dependencyId of ctx.dependencyIds) {
    if (!usedDependencies.has(dependencyId)) {
      fail(
        'INVALID_DEPENDENCY',
        `dependency "${dependencyId}" is declared but not used by any subworkflow step`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// phase 4 helpers
// ---------------------------------------------------------------------------

function validateProvenance(provenance: Loose): void {
  assertNoUnknownFields(provenance, new Set(['origin', 'generator', 'sourceReferences']), 'provenance');
  const origin = provenance.origin;
  if (origin !== 'authored' && origin !== 'compiled') {
    fail(
      'INVALID_PROVENANCE',
      `provenance.origin must be "authored" or "compiled", got ${JSON.stringify(String(origin))}`,
    );
  }
  const generator = provenance.generator;
  if (generator !== undefined && (typeof generator !== 'string' || generator.length === 0)) {
    fail('INVALID_PROVENANCE', 'provenance.generator must be a non-empty string when present');
  }
  const sourceReferences = provenance.sourceReferences;
  if (sourceReferences !== undefined) {
    if (!Array.isArray(sourceReferences)) {
      fail('INVALID_PROVENANCE', 'provenance.sourceReferences must be an array');
    }
    sourceReferences.forEach((reference, index) => {
      if (typeof reference !== 'string' || !SOURCE_REFERENCE_PATTERN.test(reference)) {
        fail(
          'INVALID_PROVENANCE',
          `provenance.sourceReferences[${index}] must be an opaque reference token, got ${JSON.stringify(String(reference))}`,
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// phase 5 helpers — edges + control graph
// ---------------------------------------------------------------------------

function validateGraph(rawEdges: unknown[], ctx: ValidationContext): void {
  // start/end presence
  if (ctx.startId === '') {
    fail('START_NODE_INVALID', 'the graph must declare exactly one start node');
  }
  if (ctx.endIds.size === 0) {
    fail('END_NODE_INVALID', 'the graph must declare at least one end node');
  }

  const edges: Loose[] = [];
  const edgeTuples = new Set<string>();

  rawEdges.forEach((rawEdge, index) => {
    if (!isPlainObject(rawEdge)) {
      fail('INVALID_EDGE', `edges[${index}] must be an object`);
    }
    assertNoUnknownFields(rawEdge, new Set(['from', 'to', 'kind', 'case']), `edges[${index}]`);
    for (const endpoint of ['from', 'to']) {
      if (!(endpoint in rawEdge)) {
        fail('MISSING_FIELD', `edges[${index}] is missing required field "${endpoint}"`);
      }
    }
    const from = rawEdge.from;
    const to = rawEdge.to;
    if (typeof from !== 'string' || typeof to !== 'string') {
      fail('INVALID_FIELD', `edges[${index}] from/to must be strings`);
    }
    const kind = rawEdge.kind;
    if (typeof kind !== 'string' || !EDGE_KINDS.includes(kind)) {
      fail(
        'INVALID_FIELD',
        `edges[${index}].kind must be one of ${EDGE_KINDS.join('|')}, got ${JSON.stringify(String(kind))}`,
      );
    }
    if (from === to) {
      fail('INVALID_EDGE', `edges[${index}] is a self edge on "${from}"`);
    }
    if (!ctx.nodeById.has(from)) {
      fail('UNKNOWN_NODE', `edges[${index}] starts at unknown node "${from}"`);
    }
    if (!ctx.nodeById.has(to)) {
      fail('UNKNOWN_NODE', `edges[${index}] ends at unknown node "${to}"`);
    }
    const caseValue = rawEdge.case;
    if (kind !== 'on_case' && caseValue !== undefined) {
      fail(
        'INVALID_CONTROL_EDGE',
        `edges[${index}] declares a case reference on a non-on_case edge`,
      );
    }
    if (kind === 'on_case' && (typeof caseValue !== 'string' || caseValue.length === 0)) {
      fail('INVALID_CONTROL_EDGE', `edges[${index}] on_case edge requires a case reference`);
    }
    const tuple = `${from}\u0000${kind}\u0000${typeof caseValue === 'string' ? caseValue : ''}\u0000${to}`;
    if (edgeTuples.has(tuple)) {
      fail('DUPLICATE_EDGE', `duplicate edge ${from} --${kind}--> ${to}`);
    }
    edgeTuples.add(tuple);
    edges.push(rawEdge);
  });

  // start/end topology
  for (const edge of edges) {
    const target = ctx.nodeById.get(edge.to as string)!;
    if (target.kind === 'start') {
      fail('START_NODE_INVALID', `start node "${String(edge.to)}" must not have incoming edges`);
    }
    const source = ctx.nodeById.get(edge.from as string)!;
    if (source.kind === 'end') {
      fail('END_NODE_INVALID', `end node "${String(edge.from)}" must not have outgoing edges`);
    }
  }

  // control semantics per source node kind
  for (const edge of edges) {
    const source = ctx.nodeById.get(edge.from as string)!;
    const kind = edge.kind as string;
    const sourceId = edge.from as string;
    if (source.kind === 'start' && kind !== 'on_success') {
      fail(
        'INVALID_CONTROL_EDGE',
        `start node "${sourceId}" may only emit on_success edges, got ${kind}`,
      );
    }
    if (source.kind === 'step') {
      const isApproval = source.requestApproval === true;
      if (isApproval && kind !== 'on_approval' && kind !== 'on_rejection') {
        fail(
          'INVALID_CONTROL_EDGE',
          `approval step "${sourceId}" may only emit on_approval/on_rejection edges, got ${kind}`,
        );
      }
      if (!isApproval && kind !== 'on_success' && kind !== 'on_failure') {
        fail(
          'INVALID_CONTROL_EDGE',
          `step "${sourceId}" may only emit on_success/on_failure edges, got ${kind}`,
        );
      }
    }
    if (source.kind === 'decision') {
      if (kind !== 'on_case' && kind !== 'on_default') {
        fail(
          'INVALID_CONTROL_EDGE',
          `decision "${sourceId}" may only emit on_case/on_default edges, got ${kind}`,
        );
      }
      if (kind === 'on_case') {
        const caseId = edge.case as string;
        const cases = ctx.decisionCases.get(sourceId) ?? [];
        if (!cases.some((decisionCase) => decisionCase.id === caseId)) {
          fail(
            'INVALID_CONTROL_EDGE',
            `on_case edge from "${sourceId}" references undeclared case "${caseId}"`,
          );
        }
      }
    }
  }

  // unambiguous control: exactly the required edge counts
  const startSuccess = edges.filter(
    (edge) => edge.from === ctx.startId && edge.kind === 'on_success',
  );
  if (startSuccess.length !== 1) {
    fail(
      'AMBIGUOUS_CONTROL',
      `start node "${ctx.startId}" must have exactly one on_success edge, got ${startSuccess.length}`,
    );
  }

  for (const [nodeId, node] of ctx.nodeById) {
    if (node.kind === 'step') {
      const out = edges.filter((edge) => edge.from === nodeId);
      if (node.requestApproval === true) {
        const approvals = out.filter((edge) => edge.kind === 'on_approval');
        const rejections = out.filter((edge) => edge.kind === 'on_rejection');
        if (approvals.length !== 1 || rejections.length !== 1) {
          fail(
            'AMBIGUOUS_CONTROL',
            `approval step "${nodeId}" must have exactly one on_approval and one on_rejection edge`,
          );
        }
      } else {
        const successes = out.filter((edge) => edge.kind === 'on_success');
        const failures = out.filter((edge) => edge.kind === 'on_failure');
        if (successes.length !== 1) {
          fail(
            'AMBIGUOUS_CONTROL',
            `step "${nodeId}" must have exactly one on_success edge, got ${successes.length}`,
          );
        }
        if (failures.length > 1) {
          fail(
            'AMBIGUOUS_CONTROL',
            `step "${nodeId}" may have at most one on_failure edge, got ${failures.length}`,
          );
        }
      }
    }
    if (node.kind === 'decision') {
      const out = edges.filter((edge) => edge.from === nodeId);
      const defaults = out.filter((edge) => edge.kind === 'on_default');
      if (defaults.length !== 1) {
        fail(
          'AMBIGUOUS_CONTROL',
          `decision "${nodeId}" must have exactly one on_default edge, got ${defaults.length}`,
        );
      }
      const cases = ctx.decisionCases.get(nodeId) ?? [];
      for (const decisionCase of cases) {
        const caseId = decisionCase.id as string;
        const caseEdges = out.filter(
          (edge) => edge.kind === 'on_case' && edge.case === caseId,
        );
        if (caseEdges.length !== 1) {
          fail(
            'AMBIGUOUS_CONTROL',
            `decision "${nodeId}" case "${caseId}" must be covered by exactly one on_case edge`,
          );
        }
      }
    }
  }

  // reachability from the start node
  const adjacency = new Map<string, string[]>();
  for (const nodeId of ctx.nodeOrder) adjacency.set(nodeId, []);
  for (const edge of edges) {
    adjacency.get(edge.from as string)!.push(edge.to as string);
  }
  const visited = new Set<string>([ctx.startId]);
  const queue: string[] = [ctx.startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current)!) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  for (const nodeId of ctx.nodeOrder) {
    if (!visited.has(nodeId)) {
      fail('UNREACHABLE_NODE', `node "${nodeId}" is not reachable from the start node`);
    }
  }

  // acyclicity (Kahn's algorithm over the full graph)
  const inDegree = new Map<string, number>();
  for (const nodeId of ctx.nodeOrder) inDegree.set(nodeId, 0);
  for (const edge of edges) {
    const target = edge.to as string;
    inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  }
  const pending = ctx.nodeOrder.filter((nodeId) => inDegree.get(nodeId) === 0);
  let processed = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    processed += 1;
    for (const next of adjacency.get(current)!) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) pending.push(next);
    }
  }
  if (processed !== ctx.nodeOrder.length) {
    fail('CONTROL_CYCLE', 'the control graph contains a cycle');
  }
}

// ---------------------------------------------------------------------------
// phase 6 helpers — data bindings
// ---------------------------------------------------------------------------

function validateDataBindings(rawBindings: unknown[], ctx: ValidationContext): void {
  const boundNodeInputs = new Map<string, Loose>();
  const boundWorkflowOutputs = new Map<string, Loose>();
  const usedWorkflowInputs = new Set<string>();

  rawBindings.forEach((rawBinding, index) => {
    if (!isPlainObject(rawBinding)) {
      fail('INVALID_BINDING', `dataBindings[${index}] must be an object`);
    }
    assertNoUnknownFields(rawBinding, new Set(['source', 'target']), `dataBindings[${index}]`);
    if (!('source' in rawBinding) || !('target' in rawBinding)) {
      fail('INVALID_BINDING', `dataBindings[${index}] requires both source and target`);
    }
    const source = rawBinding.source;
    const target = rawBinding.target;
    if (!isPlainObject(source) || !isPlainObject(target)) {
      fail('INVALID_BINDING', `dataBindings[${index}] source and target must be objects`);
    }

    // -- source integrity (UNKNOWN_NODE / INVALID_BINDING / UNKNOWN_PORT /
    //    literal validation), then target integrity + duplicate detection,
    //    then the typed-connection check (TYPE_MISMATCH before coverage)
    const sourceType = validateBindingSource(source, index, ctx, usedWorkflowInputs);
    const targetType = validateBindingTarget(
      target, index, ctx, boundNodeInputs, boundWorkflowOutputs, rawBinding,
    );

    if (!valueTypesEqual(sourceType, targetType)) {
      fail(
        'TYPE_MISMATCH',
        `dataBindings[${index}] binds ${describeType(sourceType)} into ${describeType(targetType)} — typed ports require exact type equality (no silent coercion)`,
      );
    }
  });

  // -- exactly-once coverage: node input ports, then workflow outputs, then
  //    workflow inputs
  const allInputPorts: Array<[string, Map<string, Loose>]> = [
    ...ctx.stepInputPorts,
    ...ctx.decisionInputPorts,
  ];
  for (const [nodeId, ports] of allInputPorts) {
    for (const portId of ports.keys()) {
      if (!boundNodeInputs.has(`${nodeId}\u0000${portId}`)) {
        fail('UNBOUND_INPUT', `node input port ${nodeId}.${portId} is not bound`);
      }
    }
  }
  for (const outputId of ctx.workflowOutputs.keys()) {
    if (!boundWorkflowOutputs.has(outputId)) {
      fail('UNBOUND_INPUT', `workflow output "${outputId}" is not bound`);
    }
  }
  for (const inputId of ctx.workflowInputs.keys()) {
    if (!usedWorkflowInputs.has(inputId)) {
      fail('UNBOUND_WORKFLOW_INPUT', `workflow input "${inputId}" is never bound`);
    }
  }
}

function validateBindingSource(
  source: Loose,
  index: number,
  ctx: ValidationContext,
  usedWorkflowInputs: Set<string>,
): unknown {
  const kind = source.kind;
  if (kind === 'workflow_input') {
    assertNoUnknownFields(source, new Set(['kind', 'input']), `dataBindings[${index}].source`);
    const input = source.input;
    if (typeof input !== 'string') {
      fail('INVALID_BINDING', `dataBindings[${index}].source.workflow_input requires an input id`);
    }
    const declared = ctx.workflowInputs.get(input);
    if (declared === undefined) {
      fail('INVALID_BINDING', `binding source references undeclared workflow input "${input}"`);
    }
    usedWorkflowInputs.add(input);
    return declared.type;
  }
  if (kind === 'node_output') {
    assertNoUnknownFields(source, new Set(['kind', 'node', 'port']), `dataBindings[${index}].source`);
    const node = source.node;
    const port = source.port;
    if (typeof node !== 'string' || typeof port !== 'string') {
      fail('INVALID_BINDING', `dataBindings[${index}].source.node_output requires node and port ids`);
    }
    const sourceNode = ctx.nodeById.get(node);
    if (sourceNode === undefined) {
      fail('UNKNOWN_NODE', `binding source references unknown node "${node}"`);
    }
    if (sourceNode.kind !== 'step') {
      fail(
        'INVALID_BINDING',
        `binding sources from node_output of non-step "${node}" (${String(sourceNode.kind)} nodes have no outputs)`,
      );
    }
    const outputPort = ctx.stepOutputPorts.get(node)?.get(port);
    if (outputPort === undefined) {
      fail('UNKNOWN_PORT', `binding source references undeclared output port ${node}.${port}`);
    }
    return outputPort.type;
  }
  if (kind === 'literal') {
    assertNoUnknownFields(source, new Set(['kind', 'literal']), `dataBindings[${index}].source`);
    return validateLiteral(source.literal, index);
  }
  fail('INVALID_BINDING', `unknown binding source kind "${String(kind)}" (no implicit side effects)`);
}

function validateBindingTarget(
  target: Loose,
  index: number,
  ctx: ValidationContext,
  boundNodeInputs: Map<string, Loose>,
  boundWorkflowOutputs: Map<string, Loose>,
  binding: Loose,
): unknown {
  const kind = target.kind;
  if (kind === 'node_input') {
    assertNoUnknownFields(target, new Set(['kind', 'node', 'port']), `dataBindings[${index}].target`);
    const node = target.node;
    const port = target.port;
    if (typeof node !== 'string' || typeof port !== 'string') {
      fail('INVALID_BINDING', `dataBindings[${index}].target.node_input requires node and port ids`);
    }
    const targetNode = ctx.nodeById.get(node);
    if (targetNode === undefined) {
      fail('UNKNOWN_NODE', `binding target references unknown node "${node}"`);
    }
    if (targetNode.kind !== 'step' && targetNode.kind !== 'decision') {
      fail(
        'INVALID_BINDING',
        `binding targets node_input on "${node}" (${String(targetNode.kind)} nodes have no data ports)`,
      );
    }
    const ports =
      targetNode.kind === 'step' ? ctx.stepInputPorts.get(node) : ctx.decisionInputPorts.get(node);
    const inputPort = ports?.get(port);
    if (inputPort === undefined) {
      fail('UNKNOWN_PORT', `binding target references undeclared input port ${node}.${port}`);
    }
    const key = `${node}\u0000${port}`;
    if (boundNodeInputs.has(key)) {
      fail('DUPLICATE_INPUT_BINDING', `node input port ${node}.${port} is bound more than once`);
    }
    boundNodeInputs.set(key, binding);
    return inputPort.type;
  }
  if (kind === 'workflow_output') {
    assertNoUnknownFields(target, new Set(['kind', 'output']), `dataBindings[${index}].target`);
    const output = target.output;
    if (typeof output !== 'string') {
      fail('INVALID_BINDING', `dataBindings[${index}].target.workflow_output requires an output id`);
    }
    const declared = ctx.workflowOutputs.get(output);
    if (declared === undefined) {
      fail('INVALID_BINDING', `binding target references undeclared workflow output "${output}"`);
    }
    if (boundWorkflowOutputs.has(output)) {
      fail('DUPLICATE_INPUT_BINDING', `workflow output "${output}" is bound more than once`);
    }
    boundWorkflowOutputs.set(output, binding);
    return declared.type;
  }
  fail('INVALID_BINDING', `unknown binding target kind "${String(kind)}"`);
}

function validateLiteral(rawLiteral: unknown, index: number): unknown {
  if (!isPlainObject(rawLiteral)) {
    fail('INVALID_LITERAL', `dataBindings[${index}].source.literal must be an object`);
  }
  assertNoUnknownFields(rawLiteral, new Set(['type', 'value']), `dataBindings[${index}].source.literal`);
  const type = rawLiteral.type;
  // secrets are structurally inexpressible — this is the load-bearing guard
  if (type === 'secret_ref') {
    fail(
      'SECRET_LITERAL_FORBIDDEN',
      'secret literals are forbidden — secrets travel only as opaque secret_ref references through authorized runtime paths, never as literal values',
    );
  }
  if (typeof type !== 'string' || !LITERAL_TYPES.includes(type)) {
    fail(
      'INVALID_LITERAL',
      `literal type must be one of ${LITERAL_TYPES.join('|')} (only scalar/json inline values exist), got ${JSON.stringify(String(type))}`,
    );
  }
  if (!('value' in rawLiteral)) {
    fail('INVALID_LITERAL', 'literal requires a value');
  }
  const value = rawLiteral.value;
  switch (type) {
    case 'string':
      if (typeof value !== 'string') {
        fail('INVALID_LITERAL', 'string literal value must be a string');
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
        fail('INVALID_LITERAL', 'number literal value must be a finite, non-negative-zero number');
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        fail('INVALID_LITERAL', 'boolean literal value must be a boolean');
      }
      break;
    case 'json':
      if (!isCanonicalJsonSafe(value)) {
        fail('INVALID_LITERAL', 'json literal value must be deterministic canonical JSON data');
      }
      break;
  }
  return type;
}

function valueTypesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' || typeof b === 'string') {
    return a === b;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== 1 || keysB.length !== 1) return false;
    if (keysA[0] !== keysB[0]) return false;
    return valueTypesEqual(a[keysA[0]!], b[keysB[0]!]);
  }
  return false;
}

function describeType(type: unknown): string {
  return JSON.stringify(type) ?? String(type);
}

// ---------------------------------------------------------------------------
// phase 7 helpers — requirements
// ---------------------------------------------------------------------------

function validateRequirements(requirements: Loose, ctx: ValidationContext): void {
  assertNoUnknownFields(requirements, new Set(['capabilities', 'placement']), 'requirements');
  if (!('capabilities' in requirements) || !('placement' in requirements)) {
    fail('MISSING_FIELD', 'requirements requires capabilities and placement');
  }
  const capabilities = requirements.capabilities;
  if (!Array.isArray(capabilities)) {
    fail('INVALID_FIELD', 'requirements.capabilities must be an array');
  }
  const authoredSet = new Set<string>();
  for (const capability of capabilities) {
    validateCapabilityIdentifier(capability, 'requirements.capabilities entry');
    authoredSet.add(capability as string);
  }

  const placement = requirements.placement;
  if (!isPlainObject(placement)) {
    fail('INVALID_FIELD', 'requirements.placement must be an object');
  }
  assertNoUnknownFields(placement, new Set(['locality', 'disallowed']), 'requirements.placement');
  const locality = placement.locality;
  if (
    typeof locality !== 'string' ||
    !WORKFLOW_IR_PLACEMENT_IDS.includes(locality as (typeof WORKFLOW_IR_PLACEMENT_IDS)[number])
  ) {
    fail(
      'INVALID_PLACEMENT',
      `requirements.placement.locality must be a canonical placement id (${WORKFLOW_IR_PLACEMENT_IDS.join('|')}) — V2-CTRL-003 forbids aliases, got ${JSON.stringify(String(locality))}`,
    );
  }
  const disallowed = placement.disallowed;
  if (disallowed !== undefined) {
    if (!Array.isArray(disallowed)) {
      fail('INVALID_PLACEMENT', 'requirements.placement.disallowed must be an array');
    }
    for (const entry of disallowed) {
      if (
        typeof entry !== 'string' ||
        !WORKFLOW_IR_PLACEMENT_IDS.includes(entry as (typeof WORKFLOW_IR_PLACEMENT_IDS)[number])
      ) {
        fail(
          'INVALID_PLACEMENT',
          `requirements.placement.disallowed entries must be canonical placement ids, got ${JSON.stringify(String(entry))}`,
        );
      }
    }
    if (disallowed.includes(locality)) {
      fail(
        'PLACEMENT_CONTRADICTION',
        `requirements.placement requires "${locality}" while disallowing it`,
      );
    }
  }

  // the authored capability set must agree with the set derived from steps
  const derived = [...ctx.derivedCapabilities].sort();
  const authored = [...authoredSet].sort();
  if (derived.join('\u0000') !== authored.join('\u0000')) {
    fail(
      'INVALID_FIELD',
      `requirements.capabilities ${JSON.stringify(authored)} disagrees with the capabilities derived from steps ${JSON.stringify(derived)} — the requirement set is derived from the workflow meaning`,
    );
  }
}

// ---------------------------------------------------------------------------
// phase 8 — canonical form
// ---------------------------------------------------------------------------

function buildCanonicalForm(doc: Loose, ctx: ValidationContext): WorkflowIR {
  const nodes: WorkflowIRNode[] = [];
  for (const nodeId of [...ctx.nodeOrder].sort()) {
    const node = ctx.nodeById.get(nodeId)!;
    nodes.push(buildCanonicalNode(node, ctx));
  }

  const edges: WorkflowIREdge[] = (doc.edges as Loose[]).map((edge) => {
    const canonical: WorkflowIREdge = {
      from: edge.from as string,
      kind: edge.kind as WorkflowIREdge['kind'],
      to: edge.to as string,
    };
    if (typeof edge.case === 'string') canonical.case = edge.case;
    return canonical;
  });
  edges.sort((a, b) =>
    compareStrings([a.from, a.kind, a.case ?? '', a.to], [b.from, b.kind, b.case ?? '', b.to]),
  );

  const dataBindings: WorkflowIRDataBinding[] = (doc.dataBindings as Loose[]).map((binding) => ({
    source: buildCanonicalSource(binding.source as Loose),
    target: buildCanonicalTarget(binding.target as Loose),
  }));
  dataBindings.sort((a, b) => compareStrings(bindingSortKey(a), bindingSortKey(b)));

  const inputs: WorkflowIRPort[] = canonicalPorts(ctx.workflowInputs);
  const outputs: WorkflowIRPort[] = canonicalPorts(ctx.workflowOutputs);

  const dependencies: WorkflowIRDependency[] = (doc.dependencies as Loose[])
    .map((dependency) => ({
      id: dependency.id as string,
      workflowVersionId: dependency.workflowVersionId as string,
    }))
    .sort((a, b) => compareStrings([a.id], [b.id]));

  const requirements = doc.requirements as Loose;
  const placement = requirements.placement as Loose;
  const locality = placement.locality as WorkflowIR['requirements']['placement']['locality'];
  const disallowed = Array.isArray(placement.disallowed)
    ? [...new Set(placement.disallowed as string[])].sort()
    : [];

  const provenance = doc.provenance as Loose;
  const origin = provenance.origin as WorkflowIRProvenance['origin'];
  const sourceReferences = Array.isArray(provenance.sourceReferences)
    ? [...new Set(provenance.sourceReferences as string[])].sort()
    : [];

  const canonical: WorkflowIR = {
    schemaVersion: doc.schemaVersion as number,
    nodes,
    edges,
    dataBindings,
    inputs,
    outputs,
    dependencies,
    requirements: {
      capabilities: [...ctx.derivedCapabilities].sort(),
      placement:
        disallowed.length > 0
          ? { locality, disallowed }
          : { locality },
    },
    provenance: {
      origin,
      ...(provenance.generator !== undefined
        ? { generator: provenance.generator as string }
        : {}),
      ...(sourceReferences.length > 0 ? { sourceReferences } : {}),
    },
  };
  return deepFreeze(canonical);
}

function buildCanonicalNode(node: Loose, ctx: ValidationContext): WorkflowIRNode {
  const kind = node.kind as string;
  const id = node.id as string;
  if (kind === 'start') {
    return { kind: 'start', id };
  }
  if (kind === 'end') {
    if (node.outcome === 'failure') {
      return { kind: 'end', id, outcome: 'failure' };
    }
    return { kind: 'end', id };
  }
  if (kind === 'decision') {
    const cases = (ctx.decisionCases.get(id) ?? []).map((decisionCase) => {
      const condition = decisionCase.condition as Loose;
      if (condition.kind === 'exists') {
        return { id: decisionCase.id as string, condition: { kind: 'exists' as const } };
      }
      return {
        id: decisionCase.id as string,
        condition: {
          kind: 'equals' as const,
          value: condition.value as string | number | boolean,
        },
      };
    });
    const inputPorts = canonicalPorts(ctx.decisionInputPorts.get(id) ?? new Map());
    if (inputPorts.length > 0) {
      return { kind: 'decision', id, inputs: inputPorts, cases } satisfies WorkflowIRDecisionNode;
    }
    return { kind: 'decision', id, cases } satisfies WorkflowIRDecisionNode;
  }
  const step: WorkflowIRStepNode = {
    kind: 'step',
    id,
    instruction: node.instruction as string,
    executionClass: node.executionClass as WorkflowIRStepNode['executionClass'],
    inputs: canonicalPorts(ctx.stepInputPorts.get(id) ?? new Map()),
    outputs: canonicalPorts(ctx.stepOutputPorts.get(id) ?? new Map()),
    ...(node.capability !== undefined ? { capability: node.capability as string } : {}),
    ...(node.dependency !== undefined ? { dependency: node.dependency as string } : {}),
    ...(node.pauseSafe === true ? { pauseSafe: true } : {}),
    ...(node.requestApproval === true ? { requestApproval: true } : {}),
    ...(node.failure !== undefined && ((node.failure as Loose).retry as number) > 0
      ? { failure: { retry: (node.failure as Loose).retry as number } }
      : {}),
  };
  return step;
}

function canonicalPorts(ports: Map<string, Loose>): WorkflowIRPort[] {
  return [...ports.entries()]
    .sort(([idA], [idB]) => compareStrings([idA], [idB]))
    .map(([portId, port]) => ({ id: portId, type: cloneType(port.type) }));
}

function cloneType(type: unknown): WorkflowIRValueType {
  if (typeof type === 'string') return type as WorkflowIRValueType;
  const loose = type as Loose;
  if ('list' in loose) return { list: cloneType(loose.list) };
  return { record: cloneType(loose.record) };
}

function buildCanonicalSource(source: Loose): WorkflowIRBindingSource {
  if (source.kind === 'workflow_input') {
    return { kind: 'workflow_input', input: source.input as string };
  }
  if (source.kind === 'node_output') {
    return { kind: 'node_output', node: source.node as string, port: source.port as string };
  }
  const literal = source.literal as Loose;
  return {
    kind: 'literal',
    literal: { type: literal.type as 'string' | 'number' | 'boolean' | 'json', value: literal.value },
  };
}

function buildCanonicalTarget(target: Loose): WorkflowIRBindingTarget {
  if (target.kind === 'node_input') {
    return { kind: 'node_input', node: target.node as string, port: target.port as string };
  }
  return { kind: 'workflow_output', output: target.output as string };
}

function bindingSortKey(binding: WorkflowIRDataBinding): string[] {
  const target = binding.target;
  return [
    target.kind,
    target.kind === 'node_input' ? target.node : target.output,
    target.kind === 'node_input' ? target.port : '',
    JSON.stringify(binding.source),
  ];
}

function compareStrings(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  if (a.length < b.length) return -1;
  if (a.length > b.length) return 1;
  return 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const element of value) deepFreeze(element);
    } else if (isPlainObject(value)) {
      for (const key of Object.keys(value)) deepFreeze((value as Loose)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `${typeof value} ${JSON.stringify(value) ?? String(value)}`;
}

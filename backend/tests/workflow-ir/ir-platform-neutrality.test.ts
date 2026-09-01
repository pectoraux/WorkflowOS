import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateWorkflowIR,
  WORKFLOW_IR_EXECUTION_CLASSES,
  WORKFLOW_IR_PLACEMENT_IDS,
  WORKFLOW_IR_CANONICAL_CAPABILITIES,
  WORKFLOW_IR_CAPABILITY_ALIASES,
  WORKFLOW_IR_DIGEST_ALGORITHM,
  WORKFLOW_IR_VALUE_TYPE_TAGS,
} from '../../src/workflow-ir/index.js';
import { minimalIr, realWeeklyReportIr, expectWorkflowIRError } from './fixtures.js';

/**
 * V2-003 — platform-neutrality and registry-conformance tests.
 *
 * Work Order mapping ("Must deliver" → "no browser/desktop/mobile/cloud SDK
 * concepts in IR"; "Required regressions" → "rejection of platform-specific
 * semantics leaking into IR"; registry conformance → "Protocol-visible
 * identifiers are checked against the canonical registry").
 *
 * Three enforcement layers:
 * 1. vocabulary constants are pinned byte-for-byte against
 *    V2-CTRL-003-protocol-registry.json (the merged V2-001 contract);
 * 2. the validator rejects alias capabilities, non-canonical placement ids,
 *    non-canonical execution classes and unknown (SDK-ish) fields;
 * 3. a static source scan proves the workflow-ir domain imports no platform
 *    SDK, no HTTP/db layer, and contains no clock/randomness.
 */
const BACKEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = join(BACKEND_ROOT, '..');
const REGISTRY_JSON = JSON.parse(
  readFileSync(
    join(REPO_ROOT, 'spec', 'architecture', 'v2', 'V2-CTRL-003-protocol-registry.json'),
    'utf8',
  ),
) as {
  capabilities: Record<string, string[]>;
  executionClasses: string[];
  placement: string[];
  digest: { algorithm: string };
};

describe('WorkflowIR platform neutrality and registry conformance', () => {
  describe('vocabulary pinned to V2-CTRL-003 (the merged V2-001 contract)', () => {
    it('execution classes match the registry exactly (order included)', () => {
      expect(WORKFLOW_IR_EXECUTION_CLASSES).toEqual(REGISTRY_JSON.executionClasses);
    });

    it('placement ids match the registry exactly', () => {
      expect(WORKFLOW_IR_PLACEMENT_IDS).toEqual(REGISTRY_JSON.placement);
    });

    it('canonical capabilities match the registry set exactly (no invented names)', () => {
      const registryCapabilities = Object.values(REGISTRY_JSON.capabilities).flat();
      expect([...WORKFLOW_IR_CANONICAL_CAPABILITIES].sort()).toEqual(
        [...registryCapabilities].sort(),
      );
      expect(new Set(WORKFLOW_IR_CANONICAL_CAPABILITIES).size).toBe(
        WORKFLOW_IR_CANONICAL_CAPABILITIES.length,
      );
    });

    it('digest algorithm matches the registry rule', () => {
      expect(WORKFLOW_IR_DIGEST_ALGORITHM).toBe(REGISTRY_JSON.digest.algorithm);
    });

    it('known aliases never alias a canonical name from a different concept', () => {
      // every alias maps to a real canonical identifier, and no alias IS a
      // canonical identifier (aliasesForbidden: true in the registry)
      for (const [alias, canonical] of Object.entries(WORKFLOW_IR_CAPABILITY_ALIASES)) {
        expect(WORKFLOW_IR_CANONICAL_CAPABILITIES).toContain(canonical);
        expect(WORKFLOW_IR_CANONICAL_CAPABILITIES).not.toContain(alias);
      }
    });

    it('value type tags are a closed platform-neutral set', () => {
      const forbiddenPlatformTypes = [
        'dom_element',
        'screenshot',
        'xpath',
        'xpath_selector',
        'webdriver_element',
        'accessibility_node',
        'ui_tree',
        'bundle',
        'binary_blob',
      ];
      for (const tag of forbiddenPlatformTypes) {
        expect(WORKFLOW_IR_VALUE_TYPE_TAGS).not.toContain(tag);
      }
    });
  });

  describe('alias and platform leakage rejection at the validation boundary', () => {
    it('rejects documented non-canonical capability aliases with the canonical suggestion', () => {
      const cases: Array<[string, string]> = [
        ['messages.send', 'messaging.send'],
        ['phone.answer_call', 'phone.call.answer'],
        ['calls.answer', 'phone.call.answer'],
        ['selenium.click', 'browser.click'],
      ];
      for (const [alias, canonical] of cases) {
        const doc = structuredClone(minimalIr()) as unknown as { nodes: Array<Record<string, unknown>> };
        doc.nodes[1]!.capability = alias;
        const err = expectWorkflowIRError(
          () => validateWorkflowIR(doc),
          'CAPABILITY_ALIAS',
          alias,
        );
        expect(err.message).toContain(canonical);
      }
    });

    it('accepts a genuinely new canonical-namespace capability (registry is extensible)', () => {
      const doc = structuredClone(minimalIr()) as unknown as { nodes: Array<Record<string, unknown>>; requirements: { capabilities: string[] } };
      doc.nodes[1]!.capability = 'calendar.event.create';
      doc.requirements.capabilities = ['calendar.event.create'];
      expect(() => validateWorkflowIR(doc)).not.toThrow();
    });

    it('rejects platform SDK / host fields on nodes (unknown fields fail closed)', () => {
      for (const leak of [
        'browserDriver',
        'webdriver',
        'platform',
        'sdk',
        'os',
        'deviceModel',
        'iOSBundleId',
        'androidPackage',
        'cloudRegion',
        'hostEndpoint',
        'screenCoordinates',
      ]) {
        const doc = structuredClone(minimalIr()) as unknown as { nodes: Array<Record<string, unknown>> };
        doc.nodes[1]![leak] = 'platform-specific';
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'UNKNOWN_FIELD', leak);
      }
    });

    it('rejects platform-specific value types', () => {
      for (const bad of ['dom_element', 'screenshot', 'xpath', 'ui_tree']) {
        const doc = structuredClone(minimalIr()) as unknown as {
          nodes: Array<Record<string, unknown>>;
        };
        doc.nodes[1]!.inputs = [{ id: 'in', type: bad }];
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_FIELD', bad);
      }
    });

    it('rejects non-canonical placement ids (registry vocabulary only)', () => {
      for (const bad of ['local_only', 'on_premise', 'edge_node', 'cloud_only', 'mobile']) {
        const doc = structuredClone(minimalIr()) as unknown as {
          requirements: { placement: Record<string, unknown> };
        };
        doc.requirements.placement = { locality: bad };
        expectWorkflowIRError(() => validateWorkflowIR(doc), 'INVALID_PLACEMENT', bad);
      }
    });

    it('the real workflow uses only registry vocabulary', () => {
      const ir = validateWorkflowIR(realWeeklyReportIr());
      for (const node of ir.nodes) {
        if (node.kind === 'step' && node.capability) {
          expect(WORKFLOW_IR_CANONICAL_CAPABILITIES).toContain(node.capability);
        }
      }
      expect(WORKFLOW_IR_PLACEMENT_IDS).toContain(ir.requirements.placement.locality);
    });
  });

  describe('static source guard: the domain imports no platform/runtime dependency', () => {
    const DOMAIN_DIR = join(BACKEND_ROOT, 'src', 'workflow-ir');
    const FORBIDDEN_IMPORT_PATTERNS: Array<[RegExp, string]> = [
      [/^fastify$/, 'HTTP server layer'],
      [/^pg$/, 'database driver'],
      [/^ioredis$/, 'redis client'],
      [/^@electric-sql\/pglite$/, 'embedded database'],
      [/^playwright/, 'browser automation SDK'],
      [/^react/, 'UI framework'],
      [/^@octokit/, 'vendor SDK'],
      [/^pino$/, 'logging library'],
    ];
    const FORBIDDEN_SOURCE_PATTERNS: Array<[RegExp, string]> = [
      [/Date\.now\(\)/, 'wall-clock time'],
      [/new Date\(/, 'wall-clock time'],
      [/Math\.random/, 'randomness'],
      [/randomUUID/, 'randomness'],
      [/performance\.now/, 'wall-clock time'],
      [/\bwindow\s*\./, 'browser global'],
      [/\bdocument\s*\./, 'browser global'],
      [/\bnavigator\s*\./, 'browser global'],
      [/\bprocess\s*\./, 'process environment'],
      [/selenium/i, 'browser automation SDK name'],
      [/webdriver/i, 'browser automation SDK name'],
    ];

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) out.push(...walk(path));
        else if (entry.endsWith('.ts')) out.push(path);
      }
      return out;
    }

    it('every workflow-ir source file imports only node: builtins or relative modules', () => {
      const files = walk(DOMAIN_DIR);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        const specifiers = [
          ...source.matchAll(/import\s[^'"]*?from\s*['"]([^'"]+)['"]/g),
          ...source.matchAll(/export\s[^'"]*?from\s*['"]([^'"]+)['"]/g),
          ...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
        ].map((m) => m[1]!);
        for (const specifier of specifiers) {
          for (const [pattern, label] of FORBIDDEN_IMPORT_PATTERNS) {
            expect(
              pattern.test(specifier),
              `${relative(BACKEND_ROOT, file)} imports ${specifier} (${label})`,
            ).toBe(false);
          }
          expect(
            specifier.startsWith('node:') || specifier.startsWith('.'),
            `${relative(BACKEND_ROOT, file)} imports non-local ${specifier}`,
          ).toBe(true);
        }
      }
    });

    it('no workflow-ir source file contains clock, randomness, or platform globals', () => {
      for (const file of walk(DOMAIN_DIR)) {
        const source = readFileSync(file, 'utf8');
        for (const [pattern, label] of FORBIDDEN_SOURCE_PATTERNS) {
          // strip comments so doc mentions don't false-positive
          const codeOnly = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/g, '');
          // then strip string/template-literal CONTENTS: these patterns guard
          // against EXECUTABLE references (identifiers, expressions, globals).
          // String-literal DATA — e.g. the capability-alias rejection table
          // required by V2-CTRL-003 registry conformance rule 4, which names
          // non-canonical aliases like 'selenium.click' precisely so the
          // validator can reject them — is not an executable SDK reference;
          // the import guard above remains fully strict and still forbids
          // importing any SDK.
          const codeWithoutLiterals = codeOnly
            .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
            .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
            .replace(/`(?:[^`\\]|\\.)*`/g, '``');
          expect(
            pattern.test(codeWithoutLiterals),
            `${relative(BACKEND_ROOT, file)} contains ${label} (${pattern})`,
          ).toBe(false);
        }
      }
    });
  });
});

/**
 * Loads the committed, tunable gate policy (jev.gate.json) and the vendored
 * rubric (rubrics.json). Both are plain JSON so they can be reviewed and
 * diffed like any other config — see jev.gate.json's `_meta` for the policy
 * doc this implements.
 */
import { readFileSync } from 'node:fs';
import {
  ALL_CATEGORIES,
  type Aggregate,
  type CategoryId,
  type CategoryRubric,
  type GateConfig,
  type GateMode,
  type RoleRule,
  type RubricQuestion,
  type Rubrics,
} from './types.js';

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`jev-gate: cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`jev-gate: ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && (ALL_CATEGORIES as readonly string[]).includes(value);
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`jev-gate: config field "${field}" must be an array of strings`);
  }
  return value;
}

function asCategoryArray(value: unknown, field: string): CategoryId[] {
  const arr = asStringArray(value, field);
  const bad = arr.find((v) => !isCategoryId(v));
  if (bad) throw new Error(`jev-gate: config field "${field}" has unknown category "${bad}"`);
  return arr as CategoryId[];
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`jev-gate: config field "${field}" must be a number`);
  }
  return value;
}

function parseRole(raw: unknown, index: number): RoleRule {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`jev-gate: roles[${index}] must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const name = r['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`jev-gate: roles[${index}].name must be a non-empty string`);
  }
  const glob = asStringArray(r['glob'], `roles[${index}].glob`);
  const role: RoleRule = { name, glob };
  if (r['skip'] === true) role.skip = true;
  if (r['exempt'] !== undefined) role.exempt = asCategoryArray(r['exempt'], `roles[${index}].exempt`);
  if (typeof r['hint'] === 'string') role.hint = r['hint'];
  return role;
}

export function loadGateConfig(path: string): GateConfig {
  const data = readJson(path) as Record<string, unknown>;
  const thresholds = data['thresholds'] as Record<string, unknown> | undefined;
  if (!thresholds) throw new Error('jev-gate: config is missing "thresholds"');
  const category = thresholds['category'] as Record<string, unknown>;
  const overall = thresholds['overall'] as Record<string, unknown>;
  const confidence = thresholds['confidence'] as Record<string, unknown>;
  const ratchet = thresholds['ratchet'] as Record<string, unknown>;
  const rolesRaw = data['roles'];
  if (!Array.isArray(rolesRaw)) throw new Error('jev-gate: config field "roles" must be an array');

  const modeRaw = data['mode'] ?? 'enforcing';
  if (modeRaw !== 'advisory' && modeRaw !== 'enforcing') {
    throw new Error(`jev-gate: config field "mode" must be "advisory" or "enforcing", got "${String(modeRaw)}"`);
  }
  const mode = modeRaw as GateMode;

  return {
    mode,
    thresholds: {
      category: { fail: asNumber(category['fail'], 'thresholds.category.fail'), warn: asNumber(category['warn'], 'thresholds.category.warn') },
      overall: { fail: asNumber(overall['fail'], 'thresholds.overall.fail'), warn: asNumber(overall['warn'], 'thresholds.overall.warn') },
      confidence: { blockingMin: asNumber(confidence['blockingMin'], 'thresholds.confidence.blockingMin') },
      ratchet: {
        categoryDrop: asNumber(ratchet['categoryDrop'], 'thresholds.ratchet.categoryDrop'),
        overallDrop: asNumber(ratchet['overallDrop'], 'thresholds.ratchet.overallDrop'),
      },
    },
    gatingCategories: asCategoryArray(data['gatingCategories'], 'gatingCategories'),
    advisoryCategories: asCategoryArray(data['advisoryCategories'], 'advisoryCategories'),
    roles: rolesRaw.map((r, i) => parseRole(r, i)),
    sourceExtensions: asStringArray(data['sourceExtensions'], 'sourceExtensions').map((e) => e.toLowerCase()),
    skipDirs: asStringArray(data['skipDirs'], 'skipDirs'),
    baselinePath: typeof data['baselinePath'] === 'string' ? data['baselinePath'] : 'jev.baseline.json',
    maxFileBytes: asNumber(data['maxFileBytes'] ?? 400_000, 'maxFileBytes'),
    chunkChars: asNumber(data['chunkChars'] ?? 40_000, 'chunkChars'),
    diffCharBudget: asNumber(data['diffCharBudget'] ?? 20_000, 'diffCharBudget'),
    defaultConcurrency: asNumber(data['defaultConcurrency'] ?? 8, 'defaultConcurrency'),
  };
}

function isAggregate(value: unknown): value is Aggregate {
  return value === 'min' || value === 'mean';
}

function parseRubricQuestion(raw: unknown, where: string): RubricQuestion {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`jev-gate: rubrics.json ${where} must be an object`);
  }
  const q = raw as Record<string, unknown>;
  if (q['type'] !== 'score') {
    throw new Error(`jev-gate: rubrics.json ${where}.type must be "score"`);
  }
  if (typeof q['instructions'] !== 'string' || q['instructions'].length === 0) {
    throw new Error(`jev-gate: rubrics.json ${where}.instructions must be a non-empty string`);
  }
  if (!Array.isArray(q['criteria']) || q['criteria'].length < 2 || !q['criteria'].every((c) => typeof c === 'string')) {
    throw new Error(`jev-gate: rubrics.json ${where}.criteria must be an array of at least 2 strings`);
  }
  return { type: 'score', instructions: q['instructions'], criteria: q['criteria'] as string[] };
}

function parseCategoryRubric(raw: unknown, cat: CategoryId): CategoryRubric {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`jev-gate: rubrics.json is missing category "${cat}"`);
  }
  const e = raw as Record<string, unknown>;
  if (!isAggregate(e['aggregate'])) {
    throw new Error(`jev-gate: rubrics.json "${cat}".aggregate must be "min" or "mean", got "${String(e['aggregate'])}"`);
  }
  const questionsRaw = e['questions'];
  if (typeof questionsRaw !== 'object' || questionsRaw === null || Array.isArray(questionsRaw)) {
    throw new Error(`jev-gate: rubrics.json "${cat}".questions must be an object`);
  }
  const entries = Object.entries(questionsRaw as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(`jev-gate: rubrics.json "${cat}".questions must not be empty`);
  }
  const questions: Record<string, RubricQuestion> = {};
  for (const [subId, q] of entries) {
    if (subId.includes('.')) {
      throw new Error(`jev-gate: rubrics.json "${cat}".questions has an id containing "." ("${subId}")`);
    }
    questions[subId] = parseRubricQuestion(q, `"${cat}".questions."${subId}"`);
  }
  return { aggregate: e['aggregate'], questions };
}

export function loadRubrics(path: string): Rubrics {
  const data = readJson(path) as Record<string, unknown>;
  const rubrics = {} as Record<CategoryId, CategoryRubric>;
  for (const cat of ALL_CATEGORIES) {
    rubrics[cat] = parseCategoryRubric(data[cat], cat);
  }
  return rubrics;
}

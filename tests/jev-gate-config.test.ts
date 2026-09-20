import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGateConfig, loadRubrics } from '../scripts/jev-gate/config.js';

const dir = mkdtempSync(join(tmpdir(), 'jev-gate-cfg-'));
let n = 0;
function writeConfig(obj: unknown): string {
  const p = join(dir, `cfg-${n++}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const validConfig = {
  thresholds: {
    category: { fail: 1.5, warn: 2.5 },
    overall: { fail: 2.0, warn: 2.4 },
    confidence: { blockingMin: 0.6 },
    ratchet: { categoryDrop: 0.5, overallDrop: 0.2 },
  },
  gatingCategories: ['code_smells', 'security', 'comments'],
  advisoryCategories: [],
  roles: [{ name: 'test', glob: ['**/*.test.ts'], exempt: ['testability'] }],
  sourceExtensions: ['.ts', '.TSX'],
  skipDirs: ['node_modules'],
};

describe('loadGateConfig', () => {
  it('parses a valid config and lowercases source extensions', () => {
    const cfg = loadGateConfig(writeConfig(validConfig));
    expect(cfg.gatingCategories).toContain('security');
    expect(cfg.gatingCategories).toContain('comments');
    expect(cfg.sourceExtensions).toEqual(['.ts', '.tsx']);
    expect(cfg.baselinePath).toBe('jev.baseline.json');
    expect(cfg.roles[0]?.name).toBe('test');
  });

  it('defaults mode to "enforcing" when omitted', () => {
    expect(loadGateConfig(writeConfig(validConfig)).mode).toBe('enforcing');
  });

  it('respects an explicit advisory mode', () => {
    expect(loadGateConfig(writeConfig({ ...validConfig, mode: 'advisory' })).mode).toBe('advisory');
  });

  it('rejects an invalid mode', () => {
    expect(() => loadGateConfig(writeConfig({ ...validConfig, mode: 'off' }))).toThrow(/mode/);
  });

  it('rejects a missing thresholds block', () => {
    const { thresholds, ...noThresholds } = validConfig;
    void thresholds;
    expect(() => loadGateConfig(writeConfig(noThresholds))).toThrow(/thresholds/);
  });

  it('rejects an unknown category', () => {
    expect(() => loadGateConfig(writeConfig({ ...validConfig, gatingCategories: ['not_a_category'] }))).toThrow(/unknown category/);
  });

  it('rejects non-JSON', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ not json');
    expect(() => loadGateConfig(p)).toThrow(/not valid JSON/);
  });
});

const validQuestion = { type: 'score', instructions: 'Look only at X.', criteria: ['worst', 'best'] };

function nestedRubrics(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const cat of ['complexity_clean_code', 'code_smells', 'testability', 'error_handling', 'security', 'comments', 'concurrency_and_idempotency', 'ai_slop']) {
    base[cat] = { aggregate: 'min', questions: { one: validQuestion, two: validQuestion } };
  }
  return { ...base, ...overrides };
}

describe('loadRubrics', () => {
  it('loads the vendored rubric with all 8 categories', () => {
    const rubrics = loadRubrics(join(process.cwd(), 'scripts/jev-gate/rubrics.json'));
    expect(Object.keys(rubrics)).toHaveLength(8);
    expect(rubrics.security.aggregate).toBe('min');
    expect(Object.keys(rubrics.security.questions).length).toBeGreaterThan(0);
    for (const q of Object.values(rubrics.comments.questions)) {
      expect(q.type).toBe('score');
      expect(Array.isArray(q.criteria)).toBe(true);
    }
  });

  it('accepts a well-formed nested rubric', () => {
    const p = join(dir, 'nested-rubrics.json');
    writeFileSync(p, JSON.stringify(nestedRubrics()));
    const rubrics = loadRubrics(p);
    expect(rubrics.security.aggregate).toBe('min');
    expect(rubrics.security.questions['one']?.instructions).toBe('Look only at X.');
  });

  it('throws when a category is missing', () => {
    const p = join(dir, 'partial-rubrics.json');
    const { security, ...rest } = nestedRubrics();
    void security;
    writeFileSync(p, JSON.stringify(rest));
    expect(() => loadRubrics(p)).toThrow(/missing category/);
  });

  it('rejects an invalid aggregate', () => {
    const p = join(dir, 'bad-aggregate.json');
    writeFileSync(p, JSON.stringify(nestedRubrics({ security: { aggregate: 'max', questions: { one: validQuestion } } })));
    expect(() => loadRubrics(p)).toThrow(/aggregate/);
  });

  it('rejects empty questions', () => {
    const p = join(dir, 'empty-questions.json');
    writeFileSync(p, JSON.stringify(nestedRubrics({ security: { aggregate: 'min', questions: {} } })));
    expect(() => loadRubrics(p)).toThrow(/must not be empty/);
  });

  it('rejects a sub id containing a dot', () => {
    const p = join(dir, 'dotted-sub.json');
    writeFileSync(p, JSON.stringify(nestedRubrics({ security: { aggregate: 'min', questions: { 'bad.id': validQuestion } } })));
    expect(() => loadRubrics(p)).toThrow(/contain/);
  });

  it('rejects a question missing instructions', () => {
    const p = join(dir, 'no-instructions.json');
    writeFileSync(p, JSON.stringify(nestedRubrics({ security: { aggregate: 'min', questions: { one: { type: 'score', criteria: ['a', 'b'] } } } })));
    expect(() => loadRubrics(p)).toThrow(/instructions/);
  });

  it('rejects a question with fewer than 2 criteria', () => {
    const p = join(dir, 'short-criteria.json');
    writeFileSync(p, JSON.stringify(nestedRubrics({ security: { aggregate: 'min', questions: { one: { type: 'score', instructions: 'x', criteria: ['only one'] } } } })));
    expect(() => loadRubrics(p)).toThrow(/criteria/);
  });
});

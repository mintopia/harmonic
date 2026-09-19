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
  roles: [{ name: 'test', glob: ['**/*.test.ts'], exempt: ['duplication'] }],
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

describe('loadRubrics', () => {
  it('loads the vendored rubric with all 7 categories', () => {
    const rubrics = loadRubrics(join(process.cwd(), 'scripts/jev-gate/rubrics.json'));
    expect(Object.keys(rubrics)).toHaveLength(7);
    expect(rubrics.security.type).toBe('score');
    expect(Array.isArray(rubrics.comments.criteria)).toBe(true);
  });

  it('throws when a category is missing', () => {
    const p = join(dir, 'partial-rubrics.json');
    writeFileSync(p, JSON.stringify({ security: { instructions: 'x', criteria: [] } }));
    expect(() => loadRubrics(p)).toThrow(/missing category/);
  });
});

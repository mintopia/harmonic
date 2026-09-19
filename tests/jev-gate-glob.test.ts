import { describe, expect, it } from 'vitest';
import { classifyRole, isInSkipDir, isSourceFile, matchesGlob } from '../scripts/jev-gate/glob.js';
import { ALL_CATEGORIES, type GateConfig } from '../scripts/jev-gate/types.js';

function makeConfig(overrides: Partial<GateConfig> = {}): GateConfig {
  return {
    mode: 'enforcing',
    thresholds: {
      category: { fail: 1.5, warn: 2.5 },
      overall: { fail: 2.0, warn: 2.4 },
      confidence: { blockingMin: 0.6 },
      ratchet: { categoryDrop: 0.5, overallDrop: 0.2 },
    },
    gatingCategories: [...ALL_CATEGORIES],
    advisoryCategories: [],
    roles: [],
    sourceExtensions: ['.ts', '.tsx', '.js'],
    skipDirs: ['node_modules', 'dist'],
    baselinePath: 'jev.baseline.json',
    maxFileBytes: 400000,
    chunkChars: 40000,
    diffCharBudget: 20000,
    defaultConcurrency: 4,
    ...overrides,
  };
}

describe('matchesGlob', () => {
  it('** spans any depth including zero', () => {
    expect(matchesGlob('src/a/b/foo.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('foo.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('src/deep/nest/x.d.ts', '**/*.d.ts')).toBe(true);
  });

  it('* stays within a single path segment', () => {
    expect(matchesGlob('src/foo.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/sub/foo.ts', 'src/*.ts')).toBe(false);
  });

  it('? matches a single non-slash char', () => {
    expect(matchesGlob('a.ts', '?.ts')).toBe(true);
    expect(matchesGlob('ab.ts', '?.ts')).toBe(false);
  });

  it('@(a|b|c) alternation matches one alternative', () => {
    expect(matchesGlob('foo.test.ts', '**/*.@(test|spec).@(ts|tsx|js|jsx)')).toBe(true);
    expect(matchesGlob('foo.spec.tsx', '**/*.@(test|spec).@(ts|tsx|js|jsx)')).toBe(true);
    expect(matchesGlob('foo.ts', '**/*.@(test|spec).@(ts|tsx|js|jsx)')).toBe(false);
  });

  it('does not treat literal regex metacharacters as patterns', () => {
    expect(matchesGlob('a.b.ts', '**/a.b.ts')).toBe(true);
    expect(matchesGlob('axb.ts', '**/a.b.ts')).toBe(false);
  });
});

describe('classifyRole', () => {
  const config = makeConfig({
    roles: [
      { name: 'type-declaration', glob: ['**/*.d.ts'], skip: true },
      { name: 'test', glob: ['**/*.@(test|spec).ts', '**/__tests__/**'], exempt: ['testability', 'duplication', 'error_handling'] },
      { name: 'migration', glob: ['**/migrations/**'], exempt: ['duplication', 'testability'] },
    ],
  });

  it('matches the first role in order (first match wins)', () => {
    const r = classifyRole('src/foo.test.ts', config);
    expect(r.roleName).toBe('test');
    expect(r.exempt.has('duplication')).toBe(true);
    expect(r.skip).toBe(false);
  });

  it('marks skip roles', () => {
    const r = classifyRole('src/types/foo.d.ts', config);
    expect(r.roleName).toBe('type-declaration');
    expect(r.skip).toBe(true);
  });

  it('falls back to a non-exempt "production" role when nothing matches', () => {
    const r = classifyRole('src/service.ts', config);
    expect(r.roleName).toBe('production');
    expect(r.skip).toBe(false);
    expect(r.exempt.size).toBe(0);
  });

  it('classifies files under a matched directory glob', () => {
    const r = classifyRole('db/migrations/0001_init.ts', config);
    expect(r.roleName).toBe('migration');
    expect(r.exempt.has('testability')).toBe(true);
  });
});

describe('isSourceFile / isInSkipDir', () => {
  const config = makeConfig();

  it('recognizes configured extensions, case-insensitively', () => {
    expect(isSourceFile('src/a.ts', config.sourceExtensions)).toBe(true);
    expect(isSourceFile('src/a.TSX', config.sourceExtensions)).toBe(true);
    expect(isSourceFile('src/a.py', config.sourceExtensions)).toBe(false);
    expect(isSourceFile('Makefile', config.sourceExtensions)).toBe(false);
  });

  it('detects any skip-dir segment in the path', () => {
    expect(isInSkipDir('node_modules/x/y.ts', config.skipDirs)).toBe(true);
    expect(isInSkipDir('a/dist/y.ts', config.skipDirs)).toBe(true);
    expect(isInSkipDir('src/distinct/y.ts', config.skipDirs)).toBe(false);
    expect(isInSkipDir('src/app/y.ts', config.skipDirs)).toBe(false);
  });
});

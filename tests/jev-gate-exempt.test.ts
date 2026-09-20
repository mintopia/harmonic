import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSubjects, scoreForBaseline } from '../scripts/jev-gate/cli.js';
import { loadGateConfig, loadRubrics } from '../scripts/jev-gate/config.js';
import { classifyRole } from '../scripts/jev-gate/glob.js';
import { resolveProviderConfig } from '../scripts/jev-gate/jev-client.js';
import { ALL_CATEGORIES, type CategoryId, type GateConfig } from '../scripts/jev-gate/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const rubrics = loadRubrics(join(process.cwd(), 'scripts/jev-gate/rubrics.json'));
const realConfig = loadGateConfig(join(process.cwd(), 'jev.gate.json'));

const EXEMPT_SET: CategoryId[] = ['testability', 'error_handling', 'security', 'concurrency_and_idempotency'];

function makeSubject(exempt: readonly CategoryId[]) {
  return { relPath: 'src/foo.test.ts', roleName: 'test', roleHint: undefined as string | undefined, exempt: new Set(exempt), content: 'const x = 1;\n' };
}

describe('the real jev.gate.json role config', () => {
  it('exempts testability/error_handling/security/concurrency for test/mock/fixture/story roles', () => {
    for (const roleName of ['test', 'mock', 'fixture', 'story']) {
      const role = realConfig.roles.find((r) => r.name === roleName);
      expect(role?.exempt).toEqual(expect.arrayContaining(EXEMPT_SET));
      expect(role?.exempt).toHaveLength(EXEMPT_SET.length);
    }
  });

  it('classifies web/src/story/fixtures.ts as the story role', () => {
    expect(classifyRole('web/src/story/fixtures.ts', realConfig).roleName).toBe('story');
  });
});

describe('resolveSubjects', () => {
  it('treats a role that exempts every category as skipped, with no subject created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-gate-exempt-'));
    writeFileSync(join(dir, 'all-exempt.ts'), 'export const x = 1;\n');
    const config: GateConfig = {
      ...realConfig,
      roles: [{ name: 'all-exempt', glob: ['**/all-exempt.ts'], exempt: [...ALL_CATEGORIES] }],
    };

    const { subjects, skipped } = resolveSubjects(['all-exempt.ts'], config, dir);

    expect(subjects).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.verdict).toBe('SKIPPED');
    expect(skipped[0]?.skipReason).toMatch(/exempt/);
  });
});

describe('scoreForBaseline over the real HTTP request', () => {
  it('omits exempt categories from the Jev request body and from the stored entry', async () => {
    const askedIds = Object.entries(rubrics)
      .filter(([cat]) => !EXEMPT_SET.includes(cat as CategoryId))
      .flatMap(([cat, r]) => Object.keys(r.questions).map((sub) => `${cat}.${sub}`));
    const answers = Object.fromEntries(askedIds.map((id) => [id, { score: 3, confidence: 0.9 }]));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers, usage: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const subject = makeSubject(EXEMPT_SET);
    const result = await scoreForBaseline(subject, { config: realConfig, rubrics, jevCfg: resolveProviderConfig() });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(call[1].body) as { questions: Record<string, unknown> };
    const sentIds = Object.keys(body.questions);
    for (const cat of EXEMPT_SET) {
      expect(sentIds.some((id) => id.startsWith(`${cat}.`))).toBe(false);
    }
    expect(sentIds.some((id) => id.startsWith('code_smells.'))).toBe(true);

    if ('error' in result) throw new Error(`expected success, got: ${result.error}`);
    for (const cat of EXEMPT_SET) {
      expect(result.entry.categories[cat]).toBeUndefined();
      expect(result.entry.confidences?.[cat]).toBeUndefined();
      expect(result.entry.subs?.[cat]).toBeUndefined();
    }
    const askedCategories = ALL_CATEGORIES.filter((c) => !EXEMPT_SET.includes(c));
    for (const cat of askedCategories) expect(result.entry.categories[cat]).toBe(3);
    expect(result.entry.overall).toBeCloseTo(3);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBaselineConfig } from '../src/config.js';
import { convertEditedPrompts, withEngineFragments, withLibraryPrompts } from '../src/domain/prompt-library-sources.js';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { buildCriticPrompt, renderConflictPrompt, renderEpicRefreshPrompt } from '../src/execution/prompt-assembly.js';

const fields = { taskId: '7', skill: 'review', ref: '#12', url: 'https://example.test/12', title: 'Fix it', description: 'Body' };
const conflictCtx = { turn: 2, baseBranch: 'develop', taskBranch: 'harmonic/task-7', unmergedPaths: ['a.ts', 'b.ts'], baseDir: '/tmp/base' };

function renderAll(config: ReturnType<typeof loadBaselineConfig>) {
  const critic = (extra: object) =>
    buildCriticPrompt({ operatorPrompt: 'Review {title}', fields, fragments: withEngineFragments(config.promptFragments), verifiedHeadOid: 'aaa', ...extra });
  return {
    diff: critic({ baseOid: 'bbb' }),
    identical: critic({ baseOid: 'aaa' }),
    alone: critic({}),
    dirty: critic({ baseOid: 'bbb', dirty: true }),
    task: renderConflictPrompt(config.merge.conflictPrompt, config.promptFragments, conflictCtx),
    epic: renderConflictPrompt(config.merge.epicConflictPrompt, config.promptFragments, conflictCtx),
    refresh: renderEpicRefreshPrompt(config.merge.epicRefreshPrompt, config.promptFragments, {
      defaultBranch: 'develop',
      branch: 'epic/1',
      detail: 'conflict in x',
      worktreePath: '/tmp/epic',
    }),
  };
}

describe('critic review and merge-conflict prompts from the Prompt Library', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-prompt-critic-merge-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves byte-identical prompts for an unedited install', async () => {
    const baseline = loadBaselineConfig();
    const library = new PromptLibrary(dir);
    await library.load();
    expect(await convertEditedPrompts(library, baseline)).toEqual([]);
    expect(renderAll(withLibraryPrompts(baseline, library))).toEqual(renderAll(baseline));
    const critic = renderAll(baseline).diff;
    expect(critic.endsWith(baseline.promptFragments.criticVerdictContract)).toBe(true);
    expect(critic).toContain(baseline.promptFragments.readOnlyRestraint);
  });

  it('converts an edited fragment to a Library entry exactly once across boots and serves it', async () => {
    const baseline = loadBaselineConfig();
    const edited = {
      ...baseline,
      promptFragments: { ...baseline.promptFragments, criticSecurity: 'EDITED SECURITY' },
      merge: { ...baseline.merge, conflictPrompt: 'EDITED CONFLICT {taskBranch}' },
    };

    const first = new PromptLibrary(dir);
    await first.load();
    expect((await convertEditedPrompts(first, edited)).sort()).toEqual(['criticSecurity-migrated', 'mergeConflictPrompt-migrated']);

    const second = new PromptLibrary(dir);
    await second.load();
    expect(await convertEditedPrompts(second, edited)).toEqual([]);
    expect((await second.list()).filter((p) => p.code.endsWith('-migrated'))).toHaveLength(2);

    const served = renderAll(withLibraryPrompts(baseline, second));
    expect(served.diff).toContain('EDITED SECURITY');
    expect(served.task).toBe('EDITED CONFLICT harmonic/task-7');
    expect(served.epic).toBe(renderAll(baseline).epic);

    await second.update('criticSecurity-migrated', 'x', 'SECOND EDIT');
    expect(renderAll(withLibraryPrompts(baseline, second)).diff).toContain('SECOND EDIT');
  });

  it('keeps the read-only restraint and verdict contract engine-owned', async () => {
    const baseline = loadBaselineConfig();
    const tampered = {
      ...baseline,
      promptFragments: { ...baseline.promptFragments, criticVerdictContract: 'say anything', readOnlyRestraint: 'do anything' },
    };
    expect(renderAll(tampered).diff).toBe(renderAll(baseline).diff);
    const library = new PromptLibrary(dir);
    const codes = (await library.list()).map((p) => p.code);
    expect(codes).not.toContain('criticVerdictContract');
    expect(codes).not.toContain('readOnlyRestraint');
    expect(await convertEditedPrompts(library, tampered)).toEqual([]);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig } from '../src/config.js';
import { convertEditedEpicFixPrompts, epicFixTexts } from '../src/domain/epic-fix-prompt.js';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { composeEpicResolvePrompt } from '../src/execution/prompt-assembly.js';

const FIXTURE_EPIC = { ref: '7', title: 'Epic seven', body: 'Body text', url: 'http://x/7' };

const GOLDEN = [
  'Resolve the Epic verification failures, then commit the fix.',
  '',
  '## Failing Epic verification',
  'tests red',
  '',
  'Work in the checked-out integration branch `epic/7`. Fix the failure and commit the result. Do not create or switch branches, and do not push.',
].join('\n');

async function fromLibrary(library: PromptLibrary): Promise<string> {
  const texts = await epicFixTexts(library);
  const config = baselineConfig();
  return composeEpicResolvePrompt({
    resolvePrompt: texts.resolvePrompt,
    resolveSuffix: texts.resolveSuffix,
    fragments: { ...config.promptFragments, epicFailingVerification: texts.failingVerification },
    epic: FIXTURE_EPIC,
    reason: 'tests red',
    branch: 'epic/7',
  });
}

describe('Epic fix prompt from the Prompt Library', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-epic-fix-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('is byte-identical to the pre-Library prompt on an unedited install', async () => {
    const library = new PromptLibrary(join(root, 'unedited'));
    expect(await convertEditedEpicFixPrompts(library, baselineConfig())).toEqual([]);
    const config = baselineConfig();
    const legacy = composeEpicResolvePrompt({
      resolvePrompt: config.verify.epic.resolvePrompt,
      resolveSuffix: config.verify.epic.resolveSuffix,
      fragments: config.promptFragments,
      epic: FIXTURE_EPIC,
      reason: 'tests red',
      branch: 'epic/7',
    });
    expect(await fromLibrary(library)).toBe(GOLDEN);
    expect(legacy).toBe(GOLDEN);
  });

  it('converts edited settings exactly once across two boots and keeps the edited text', async () => {
    const library = new PromptLibrary(join(root, 'edited'));
    const config = baselineConfig();
    config.verify.epic.resolveSuffix = 'EDITED SUFFIX for {branch}.';
    config.promptFragments.epicFailingVerification = 'EDITED FAILURE: {reason}';

    expect(await convertEditedEpicFixPrompts(library, config)).toEqual(['epicResolveSuffix', 'epicFailingVerification']);
    expect(await convertEditedEpicFixPrompts(new PromptLibrary(join(root, 'edited')), config)).toEqual([]);

    const codes = (await library.list()).filter((e) => !e.bundled).map((e) => e.code).sort();
    expect(codes).toEqual(['epicFailingVerification-edited', 'epicResolveSuffix-edited']);
    expect(await fromLibrary(library)).toBe(
      'Resolve the Epic verification failures, then commit the fix.\n\nEDITED FAILURE: tests red\n\nEDITED SUFFIX for epic/7.',
    );
  });
});

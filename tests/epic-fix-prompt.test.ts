import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig } from '../src/config.js';
import { convertEditedEpicFixPrompts, epicFixTexts } from '../src/domain/epic-fix-prompt.js';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { NO_RETIRED } from '../src/domain/retired-settings.js';

describe('Epic fix prompt from the Prompt Library', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-epic-fix-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('uses a duplicate of a bundled entry named <code>-edited', async () => {
    const library = new PromptLibrary(join(root, 'duplicated'));
    await library.duplicate('epicResolveSuffix', 'epicResolveSuffix-edited');
    await library.update('epicResolveSuffix-edited', 'mine', 'MY SUFFIX for {branch}.');
    expect((await epicFixTexts(library)).resolveSuffix).toBe('MY SUFFIX for {branch}.');
  });

  it('leaves an unedited install on the bundled entries', async () => {
    const library = new PromptLibrary(join(root, 'unedited'));
    expect(await convertEditedEpicFixPrompts(library, baselineConfig(), NO_RETIRED)).toEqual([]);
    const config = baselineConfig();
    const texts = await epicFixTexts(library);
    expect(texts.resolvePrompt).toBe(config.verify.epic.resolvePrompt);
    expect(texts.resolveSuffix).toBe(config.verify.epic.resolveSuffix);
  });

  it('converts edited settings exactly once across two boots and keeps the edited text', async () => {
    const library = new PromptLibrary(join(root, 'edited'));
    const config = baselineConfig();
    config.verify.epic.resolveSuffix = 'EDITED SUFFIX for {branch}.';
    const retired = { global: { epicFailingVerification: 'EDITED FAILURE: {reason}' }, workspaces: {} };

    expect(await convertEditedEpicFixPrompts(library, config, retired)).toEqual(['epicResolveSuffix', 'epicFailingVerification']);
    expect(await convertEditedEpicFixPrompts(new PromptLibrary(join(root, 'edited')), config, retired)).toEqual([]);

    const codes = (await library.list()).filter((e) => !e.bundled).map((e) => e.code).sort();
    expect(codes).toEqual(['epicFailingVerification-edited', 'epicResolveSuffix-edited']);
    const texts = await epicFixTexts(library);
    expect(texts.failingVerification).toBe('EDITED FAILURE: {reason}');
    expect(texts.resolveSuffix).toBe('EDITED SUFFIX for {branch}.');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { loadBaselineConfig, type AppConfig } from '../src/config.js';
import { changedPromptCodes, convertEditedPrompts, namedPromptCodes, syncEditedPrompts, withLibraryPrompts } from '../src/domain/prompt-library-sources.js';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { convertRetiredEditedPrompts, NO_RETIRED } from '../src/domain/retired-settings.js';
import { resolvePauseMessage } from '../src/domain/setting-override.js';

function renderAll(config: AppConfig, library: PromptLibrary | null) {
  return {
    drive: config.drive,
    task: config.taskPrompt,
    pause: resolvePauseMessage(null, config, bundledEnginePrompts()),
    engine: library ? library.enginePrompts() : bundledEnginePrompts(),
  };
}

describe('implementation and nudge prompts from the Prompt Library (#904)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-prompt-impl-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function open(): Promise<PromptLibrary> {
    const library = new PromptLibrary(dir);
    await library.load();
    return library;
  }

  const edited = (): AppConfig => {
    const baseline = loadBaselineConfig();
    return { ...baseline, drive: { ...baseline.drive, continuePrompt: 'EDITED CONTINUE {taskId}' } };
  };
  const retired = { global: { peerLine: 'EDITED PEER LINE' }, workspaces: {} };

  it('resolves byte-identical prompts for an unedited install', async () => {
    const baseline = loadBaselineConfig();
    const library = await open();
    expect(await convertEditedPrompts(library, baseline)).toEqual([]);
    expect(await convertRetiredEditedPrompts(library, NO_RETIRED)).toEqual([]);
    expect(renderAll(withLibraryPrompts(baseline, library), library)).toEqual(renderAll(baseline, null));
  });

  it('converts edited prompts exactly once across boots and serves them from the Library', async () => {
    const first = await open();
    expect(await convertEditedPrompts(first, edited())).toEqual(['continuePrompt-edited']);
    expect(await convertRetiredEditedPrompts(first, retired)).toEqual(['peerLine-edited']);
    const second = await open();
    expect(await convertEditedPrompts(second, edited())).toEqual([]);
    expect(await convertRetiredEditedPrompts(second, retired)).toEqual([]);
    const served = renderAll(withLibraryPrompts(loadBaselineConfig(), second), second);
    expect(served.drive.continuePrompt).toBe('EDITED CONTINUE {taskId}');
    expect(served.engine.peerLine).toBe('EDITED PEER LINE');
    expect({ ...served.engine, peerLine: bundledEnginePrompts().peerLine }).toEqual(bundledEnginePrompts());
  });

  it('serves a Library edit made after conversion, ahead of the Settings text', async () => {
    const library = await open();
    await convertRetiredEditedPrompts(library, retired);
    await library.update('peerLine-edited', 'mine', 'LIBRARY WINS');
    expect(library.enginePrompts().peerLine).toBe('LIBRARY WINS');
  });

  it('carries a Settings write into the Library entry only for the prompts it named', async () => {
    const library = await open();
    const patch = { drive: { commitNudge: 'NEW NUDGE' } };
    const updated = { ...loadBaselineConfig(), drive: { ...loadBaselineConfig().drive, commitNudge: 'NEW NUDGE' } };
    expect([...namedPromptCodes(patch)]).toEqual(['commitNudge']);
    await syncEditedPrompts(library, updated, namedPromptCodes(patch));
    expect(library.operatorText('commitNudge-edited')).toBe('NEW NUDGE');
    expect(library.hasOperatorEntry('peerLine-edited')).toBe(false);
    expect([...changedPromptCodes(loadBaselineConfig(), updated)]).toEqual(['commitNudge']);
  });
});

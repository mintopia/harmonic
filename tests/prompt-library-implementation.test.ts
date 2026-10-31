import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBaselineConfig, type AppConfig } from '../src/config.js';
import { changedPromptCodes, convertEditedPrompts, namedPromptCodes, syncEditedPrompts, withLibraryPrompts } from '../src/domain/prompt-library-sources.js';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { resolvePauseMessage } from '../src/domain/setting-override.js';
import { PROMPT_ANATOMIES, type AnatomyNode } from '../src/domain/prompt-anatomy.js';

function renderAll(config: AppConfig) {
  return {
    drive: config.drive,
    task: config.taskPrompt,
    pause: resolvePauseMessage(null, config),
    fragments: config.promptFragments,
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
    return {
      ...baseline,
      promptFragments: { ...baseline.promptFragments, peerLine: 'EDITED PEER LINE' },
      drive: { ...baseline.drive, continuePrompt: 'EDITED CONTINUE {taskId}' },
    };
  };

  it('resolves byte-identical prompts for an unedited install', async () => {
    const baseline = loadBaselineConfig();
    const library = await open();
    expect(await convertEditedPrompts(library, baseline)).toEqual([]);
    expect(renderAll(withLibraryPrompts(baseline, library))).toEqual(renderAll(baseline));
  });

  it('converts edited prompts exactly once across boots and serves them from the Library', async () => {
    const first = await open();
    expect((await convertEditedPrompts(first, edited())).sort()).toEqual(['continuePrompt-edited', 'peerLine-edited']);
    const second = await open();
    expect(await convertEditedPrompts(second, edited())).toEqual([]);
    const served = renderAll(withLibraryPrompts(loadBaselineConfig(), second));
    expect(served).toEqual(renderAll(edited()));
    expect(served.drive.continuePrompt).toBe('EDITED CONTINUE {taskId}');
  });

  it('serves a Library edit made after conversion, ahead of the Settings text', async () => {
    const library = await open();
    await convertEditedPrompts(library, edited());
    await library.update('peerLine-edited', 'mine', 'LIBRARY WINS');
    expect(withLibraryPrompts(edited(), library).promptFragments.peerLine).toBe('LIBRARY WINS');
  });

  it('carries a Settings write into the Library entry only for the prompts it named', async () => {
    const library = await open();
    const patch = { drive: { commitNudge: 'NEW NUDGE' } };
    const updated = { ...loadBaselineConfig(), drive: { ...loadBaselineConfig().drive, commitNudge: 'NEW NUDGE' }, promptFragments: { ...loadBaselineConfig().promptFragments, peerLine: 'UNNAMED' } };
    expect([...namedPromptCodes(patch)]).toEqual(['commitNudge']);
    await syncEditedPrompts(library, updated, namedPromptCodes(patch));
    expect(library.operatorText('commitNudge-edited')).toBe('NEW NUDGE');
    expect(library.hasOperatorEntry('peerLine-edited')).toBe(false);
    expect([...changedPromptCodes(loadBaselineConfig(), updated)].sort()).toEqual(['commitNudge', 'peerLine']);
  });
});

describe('Prompts tab anatomy for the implementation and nudge prompts (#904)', () => {
  it('marks every Library-backed prompt in these anatomies as a Library entry', () => {
    const keys = new Set<string>();
    const walk = (nodes: readonly AnatomyNode[]): void => {
      for (const node of nodes) {
        if (node.kind === 'oneOf') node.options.forEach((o) => walk(o.parts));
        else {
          if (node.library === undefined) keys.add(node.key);
          walk(node.nested ?? []);
        }
      }
    };
    for (const anatomy of PROMPT_ANATOMIES.filter((a) => a.id === 'implementation' || a.id === 'nudges')) walk(anatomy.parts);
    expect([...keys]).toEqual([]);
  });
});

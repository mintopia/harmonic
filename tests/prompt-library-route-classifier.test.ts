import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBaselineConfig, type AppConfig } from '../src/config.js';
import { convertEditedPrompts, withLibraryPrompts } from '../src/domain/prompt-library-sources.js';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { PROMPT_ANATOMIES } from '../src/domain/prompt-anatomy.js';
import { resolvePromptFragments } from '../src/domain/setting-override.js';
import { buildClassifierPrompt } from '../src/execution/prompt-assembly.js';
import type { ClassifierInput } from '../src/domain/route-classifier.js';

const input: ClassifierInput = {
  title: 'Fix the flaky login test',
  description: 'It fails one run in ten.',
  labels: ['bug'],
  attemptNumber: 1,
  options: [
    { id: 'cheap-fix', description: 'cheap, small fixes', harness: 'claude', model: 'haiku' },
    { id: 'deep-work', description: 'hard, cross-cutting work', harness: 'codex', model: 'gpt' },
  ],
};

const resolved = (config: AppConfig): string => buildClassifierPrompt(input, resolvePromptFragments(null, config));

describe('Route Classifier instructions from the Prompt Library (#903)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-prompt-classifier-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot(config: AppConfig): Promise<{ library: PromptLibrary; converted: string[] }> {
    const library = new PromptLibrary(dir);
    await library.load();
    const converted = await convertEditedPrompts(library, config);
    return { library, converted };
  }

  const edited = (): AppConfig => {
    const baseline = loadBaselineConfig();
    return { ...baseline, promptFragments: { ...baseline.promptFragments, routeClassifier: 'EDITED PICK\n{options}\n{ticket}' } };
  };

  it('resolves a byte-identical classifier prompt for an unedited install', async () => {
    const baseline = loadBaselineConfig();
    const before = resolved(baseline);
    const { library, converted } = await boot(baseline);
    expect(converted).toEqual([]);
    expect(resolved(withLibraryPrompts(baseline, library))).toBe(before);
  });

  it('converts an edited classifier fragment into one Library entry across two boots', async () => {
    const first = await boot(edited());
    expect(first.converted).toEqual(['routeClassifier-edited']);
    const second = await boot(edited());
    expect(second.converted).toEqual([]);
    expect(readdirSync(join(dir, 'prompts')).filter((f) => f.startsWith('routeClassifier'))).toHaveLength(1);
    const served = resolved(withLibraryPrompts(loadBaselineConfig(), second.library));
    expect(served).toBe(resolved(edited()));
    expect(served).toMatch(/^EDITED PICK\n- cheap-fix/);
  });

  it('points the Prompts tab classifier part at the Library', () => {
    const anatomy = PROMPT_ANATOMIES.find((a) => a.id === 'routeClassifier');
    expect(anatomy?.parts).toEqual([expect.objectContaining({ key: 'fragment:routeClassifier', library: 'routeClassifier' })]);
  });
});

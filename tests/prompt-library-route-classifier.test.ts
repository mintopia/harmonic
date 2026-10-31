import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { bundledEnginePrompts, type EnginePrompts } from '../src/domain/bundled-prompts.js';
import { convertRetiredEditedPrompts, type RetiredSettings } from '../src/domain/retired-settings.js';
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

const resolved = (prompts: EnginePrompts): string => buildClassifierPrompt(input, prompts);

describe('Route Classifier instructions from the Prompt Library (#903)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-prompt-classifier-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot(retired: RetiredSettings): Promise<{ library: PromptLibrary; converted: string[] }> {
    const library = new PromptLibrary(dir);
    await library.load();
    const converted = await convertRetiredEditedPrompts(library, retired);
    return { library, converted };
  }

  const unedited: RetiredSettings = { global: {}, workspaces: {} };
  const edited = (): RetiredSettings => ({ global: { routeClassifier: 'EDITED PICK\n{options}\n{ticket}' }, workspaces: {} });

  it('resolves a byte-identical classifier prompt for an unedited install', async () => {
    const before = resolved(bundledEnginePrompts());
    const { library, converted } = await boot(unedited);
    expect(converted).toEqual([]);
    expect(resolved(library.enginePrompts())).toBe(before);
  });

  it('converts an edited classifier prompt into one Library entry across two boots', async () => {
    const first = await boot(edited());
    expect(first.converted).toEqual(['routeClassifier-edited']);
    const second = await boot(edited());
    expect(second.converted).toEqual([]);
    expect(readdirSync(join(dir, 'prompts')).filter((f) => f.startsWith('routeClassifier'))).toHaveLength(1);
    const served = resolved(second.library.enginePrompts());
    expect(served).toMatch(/^EDITED PICK\n- cheap-fix/);
  });
});

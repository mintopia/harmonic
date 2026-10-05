import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SHOTS = 'docs/screenshots/critic-resolved-prompts';
const PNG_SIGNATURE = '89504e470d0a1a0a';

describe('critic Resolved Prompt reference screenshots', () => {
  it.each(['critic-prompts', 'epic-critic-prompt'])('commits a PNG of the %s story panel', (story) => {
    const file = `${SHOTS}/${story}.png`;
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
    expect(statSync(file).size).toBeGreaterThan(20_000);
  });

  it('registers both stories the screenshots are captured from', () => {
    const source = readFileSync('web/src/story/story.tsx', 'utf8');
    expect(source).toContain("'critic-prompts': CriticPromptsStory");
    expect(source).toContain("'epic-critic-prompt': EpicStory");
  });

  it('gives every story critic attempt a locator with a prompt, including a historical task attempt and the epic critic', () => {
    const source = readFileSync('web/src/story/fixtures.ts', 'utf8');
    const locators = [...source.matchAll(/promptLocator: '([^']+)'/g)].map((m) => m[1]!);
    expect(locators.length).toBeGreaterThanOrEqual(3);
    for (const locator of locators) expect(source).toContain(`'${locator}': `);
  });
});

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runFixtureEpic } from './fixtures/epic-golden-fixture.js';

const GOLDEN = new URL('./fixtures/epic-resolve-prompts-golden.json', import.meta.url);
const TOKEN_PROMPT = 'Resolve Epic #{ref} "{title}" ({url}).\n\n{description}';

describe('Epic resolve loop golden Resolved Prompts (ADR-0028 path)', () => {
  it('sends byte-for-byte the checked-in Resolved Prompts after a failing then passing verify', async () => {
    const defaults = await runFixtureEpic();
    const tokens = await runFixtureEpic(TOKEN_PROMPT);
    for (const run of [defaults, tokens]) {
      expect(run.outcomes).toEqual(['waiting', 'integrated']);
      expect(run.prompts).toHaveLength(1);
    }
    const captured = { default: defaults.prompts[0], tokens: tokens.prompts[0] };
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(captured, null, 2)}\n`);
    expect(captured).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});

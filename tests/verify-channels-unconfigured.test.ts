import { describe, expect, it } from 'vitest';
import { verifyChannelsUnconfigured, type AppConfig } from '../src/config.js';

const verify = (): AppConfig['verify'] => ({
  task: { preMerge: { commands: [], critics: [] }, postMerge: { commands: [], critics: [] } },
  epic: { preMerge: { commands: [], critics: [] }, resolvePrompt: 'Resolve failures.' },
});

describe('verifyChannelsUnconfigured', () => {
  it('is true only when all stage lists are empty', () => {
    expect(verifyChannelsUnconfigured(verify())).toBe(true);
    const configured = verify();
    configured.epic.preMerge.critics.push({ name: 'Test critic', prompt: 'Review.', model: 'claude-opus-5' });
    expect(verifyChannelsUnconfigured(configured)).toBe(false);
  });
});

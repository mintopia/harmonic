import { describe, expect, it } from 'vitest';
import { verifyChannelsUnconfigured, type AppConfig } from '../src/config.js';

const verify = (): AppConfig['verify'] => ({
  task: { preMerge: { commands: [], critics: [] }, postMerge: { commands: [], critics: [] } },
  epic: { preMerge: { commands: [], critics: [] }, resolvePrompt: 'Resolve failures.', resolveSuffix: 'Branch {branch}.' },
});

describe('verifyChannelsUnconfigured', () => {
  it('is true only when all stage lists are empty', () => {
    expect(verifyChannelsUnconfigured(verify())).toBe(true);
    const configured = verify();
    configured.epic.preMerge.critics.push({ id: 'critic-epic', name: 'Test critic', prompt: 'Review.', harness: 'claude' as const, model: 'claude-opus-5', timeoutSeconds: 300 });
    expect(verifyChannelsUnconfigured(configured)).toBe(false);
  });
});

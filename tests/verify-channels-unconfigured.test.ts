import { describe, it, expect } from 'vitest';
import { verifyChannelsUnconfigured, type AppConfig } from '../src/config.js';

const defaultVerify = (): AppConfig['verify'] => ({ commands: [], review: { enabled: false } });

describe('verifyChannelsUnconfigured', () => {
  it('is true for the default config — no commands, review disabled', () => {
    expect(verifyChannelsUnconfigured(defaultVerify())).toBe(true);
  });

  it('is false once a command verifier is configured', () => {
    const verify = defaultVerify();
    verify.commands.push({ command: 'true', args: [], env: {}, timeoutSeconds: 30 });
    expect(verifyChannelsUnconfigured(verify)).toBe(false);
  });

  it('is false once critic review is enabled', () => {
    const verify = defaultVerify();
    verify.review.enabled = true;
    expect(verifyChannelsUnconfigured(verify)).toBe(false);
  });
});

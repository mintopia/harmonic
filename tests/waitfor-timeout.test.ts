import { describe, expect, it } from 'vitest';
import { DEFAULT_WAITFOR_TIMEOUT_MS, waitFor } from './helpers.js';

const TEST_TIMEOUT_MS = 20_000;

describe('waitFor timeout behaviour', () => {
  it('rejects with a clear message when the condition is never met', async () => {
    await expect(waitFor(async () => false, { timeoutMs: 40, intervalMs: 5 })).rejects.toThrow(
      'waitFor: condition not met in time',
    );
  });

  it('resolves with the value once the condition becomes truthy', async () => {
    let calls = 0;
    const value = await waitFor(async () => (++calls >= 3 ? 'ready' : false), { intervalMs: 5 });
    expect(value).toBe('ready');
    expect(calls).toBe(3);
  });

  it('keeps the default timeout safely below the vitest testTimeout', () => {
    expect(DEFAULT_WAITFOR_TIMEOUT_MS).toBeLessThanOrEqual(TEST_TIMEOUT_MS - 5_000);
  });
});

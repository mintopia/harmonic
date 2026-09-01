import { describe, it, expect } from 'vitest';
import { appConfigSchema, defaultConfig, mergeConfig, migrateLegacyConfig } from '../src/config.js';

describe('migrateLegacyConfig (#140, ADR-0021)', () => {
  it('drops agentReview without inventing any verify key (the review gate it described is gone, ADR-0041)', () => {
    const result = migrateLegacyConfig({ agentReview: true });
    expect(result).not.toHaveProperty('agentReview');
    expect(result).not.toHaveProperty('verify');
  });

  it('drops a legacy verification.autoAccept alongside agentReview', () => {
    const result = migrateLegacyConfig({ agentReview: true, verification: { autoAccept: false } });
    expect(result).not.toHaveProperty('agentReview');
    expect(result).not.toHaveProperty('verification');
    expect(result.verify ?? {}).not.toHaveProperty('autoAccept');
  });

  it('injects no verification when agentReview is false, and drops agentReview', () => {
    const result = migrateLegacyConfig({ agentReview: false });
    expect(result.verify).toBeUndefined();
    expect(result).not.toHaveProperty('agentReview');
  });

  it('returns an object without agentReview unchanged (minus nothing), no agentReview key', () => {
    const input = { name: 'Production', autoRunner: { enabled: true } };
    const result = migrateLegacyConfig(input);
    expect(result).toEqual(input);
    expect(result).not.toHaveProperty('agentReview');
  });

  it('drops the retired maxConcurrentRuns key at the schema boundary (renamed maxConcurrentAttempts, no fold)', () => {
    const migrated = migrateLegacyConfig({
      autoRunner: { enabled: true, maxConcurrentRuns: 7 } as { enabled: boolean },
    });
    const parsed = appConfigSchema.parse(mergeConfig(defaultConfig(), migrated));
    expect(parsed.autoRunner).not.toHaveProperty('maxConcurrentRuns');
    expect(parsed.autoRunner.maxConcurrentAttempts).toBe(defaultConfig().autoRunner.maxConcurrentAttempts);
  });
});

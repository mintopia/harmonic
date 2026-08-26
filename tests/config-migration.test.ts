import { describe, it, expect } from 'vitest';
import { migrateLegacyConfig } from '../src/config.js';

/**
 * The retired `agentReview` flag (ADR-0021, issue #140): folded into
 * `verification.autoAccept` — the verifier's pass now IS the accept. The
 * legacy key is always dropped so it never lingers in stored config nor
 * re-exposes the removed accept/reject surface.
 */
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
});

import { describe, it, expect } from 'vitest';
import { migrateLegacyConfig } from '../src/config.js';

/**
 * The retired `agentReview` flag (ADR-0021, issue #140): folded into
 * `verification.autoAccept` — the verifier's pass now IS the accept. The
 * legacy key is always dropped so it never lingers in stored config nor
 * re-exposes the removed accept/reject surface.
 */
describe('migrateLegacyConfig (#140, ADR-0021)', () => {
  it('maps agentReview: true with no verification to verification.autoAccept: true, and drops agentReview', () => {
    const result = migrateLegacyConfig({ agentReview: true });
    expect(result.verify?.autoAccept).toBe(true);
    expect(result).not.toHaveProperty('agentReview');
  });

  it('leaves an explicit verification.autoAccept: false untouched (explicit wins), and drops agentReview', () => {
    const result = migrateLegacyConfig({ agentReview: true, verification: { autoAccept: false } });
    expect(result.verify?.autoAccept).toBe(false);
    expect(result).not.toHaveProperty('agentReview');
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

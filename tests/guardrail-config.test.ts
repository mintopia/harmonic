import { describe, it, expect } from 'vitest';
import { appConfigSchema, defaultConfig } from '../src/config.js';

/**
 * The budget Guardrail's config-time rejection (issue #126, ADR-0019): a cost
 * cap with no token fallback requires every configured model to be priced,
 * enforced in `appConfigSchema`'s `superRefine` — not at Run time, since
 * nothing executes yet in #126.
 */
describe('appConfigSchema guardrail rejection (issue #126, ADR-0019)', () => {
  it('rejects a cost cap with no token fallback when a configured harness includes an unpriced model', () => {
    // The default config's copilot harness includes 'auto', which has no DEFAULT_PRICES entry.
    const config = JSON.parse(JSON.stringify(defaultConfig()));
    config.guardrails.budget.costUsd = 10;
    config.guardrails.budget.tokens = null;

    const result = appConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('costUsd'))).toBe(true);
    }
  });

  it('accepts a cost cap with a token fallback, even with an unpriced model configured', () => {
    const config = JSON.parse(JSON.stringify(defaultConfig()));
    config.guardrails.budget.costUsd = 10;
    config.guardrails.budget.tokens = 2000000;

    const result = appConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('accepts a cost cap with no token fallback when every configured model is priced', () => {
    const config = JSON.parse(JSON.stringify(defaultConfig()));
    // `harnesses` is a record over every HARNESS_ID, so all three stay present;
    // only copilot's 'auto' is unpriced — pin it to a priced model instead.
    config.harnesses.copilot.models = config.harnesses.copilot.models.filter((m: string) => m !== 'auto');
    config.harnesses.copilot.defaultModel = 'claude-sonnet-5';
    config.guardrails.budget.costUsd = 10;
    config.guardrails.budget.tokens = null;

    const result = appConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('rejects a cost cap with no token fallback when the agent critic pins an unpriced model', () => {
    const config = JSON.parse(JSON.stringify(defaultConfig()));
    // Price every harness model so only the review critic's model is unpriced.
    config.harnesses.copilot.models = config.harnesses.copilot.models.filter((m: string) => m !== 'auto');
    config.harnesses.copilot.defaultModel = 'claude-sonnet-5';
    config.verify.review = { enabled: true, prompt: 'review', model: 'unpriced-critic-model' };
    config.guardrails.budget.costUsd = 10;
    config.guardrails.budget.tokens = null;

    const result = appConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('costUsd'))).toBe(true);
    }
  });

  it('accepts no cost cap (costUsd null) — the default config parses fine', () => {
    const config = JSON.parse(JSON.stringify(defaultConfig()));
    const result = appConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

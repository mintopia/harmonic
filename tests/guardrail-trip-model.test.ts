import { describe, expect, it } from 'vitest';
import { describeGuardrailTrip } from '../web/src/guardrail-trip-model.js';
import type { GuardrailEvent } from '../web/src/types.js';

const event = (overrides: Partial<GuardrailEvent>): GuardrailEvent => ({
  id: 1,
  runId: 1,
  seq: 1,
  ts: 1_700_000_000_000,
  dimension: 'wall-clock',
  phase: 'executing',
  limitValue: 0,
  observedValue: 0,
  configSource: 'default',
  payload: {},
  ...overrides,
});

describe('describeGuardrailTrip', () => {
  it('formats a wall-clock trip in minutes from ms', () => {
    const { dimensionLabel, evidence } = describeGuardrailTrip(
      event({ dimension: 'wall-clock', limitValue: 20 * 60_000, observedValue: 24 * 60_000 }),
    );
    expect(dimensionLabel).toMatch(/wall.clock/i);
    expect(evidence).toBe('20 min limit, ran 24 min');
  });

  it('formats a tokens trip as token counts', () => {
    const { dimensionLabel, evidence } = describeGuardrailTrip(
      event({ dimension: 'tokens', limitValue: 100_000, observedValue: 128_000 }),
    );
    expect(dimensionLabel).toMatch(/token/i);
    expect(evidence).toBe('100,000 token limit, used 128,000');
  });

  it('formats a cost trip in dollars', () => {
    const { dimensionLabel, evidence } = describeGuardrailTrip(
      event({ dimension: 'cost', limitValue: 5, observedValue: 6.2 }),
    );
    expect(dimensionLabel).toMatch(/cost/i);
    expect(evidence).toBe('$5.00 limit, spent $6.20');
  });

  it('formats a progress trip with its sentinel 0 limit and surfaces the pattern', () => {
    const { dimensionLabel, evidence } = describeGuardrailTrip(
      event({ dimension: 'progress', limitValue: 0, observedValue: 4, payload: { pattern: 'repeated-tool-loop' } }),
    );
    expect(dimensionLabel).toMatch(/progress/i);
    expect(evidence).toMatch(/no progress/i);
    expect(evidence).toContain('repeated-tool-loop');
  });

  it('formats a progress trip with no pattern payload gracefully', () => {
    const { evidence } = describeGuardrailTrip(
      event({ dimension: 'progress', limitValue: 0, observedValue: 4, payload: {} }),
    );
    expect(evidence).toMatch(/no progress/i);
  });

  it('formats a tool-timeout trip in minutes from ms', () => {
    const { dimensionLabel, evidence } = describeGuardrailTrip(
      event({ dimension: 'tool-timeout', limitValue: 5 * 60_000, observedValue: 6 * 60_000, payload: { title: 'npm test' } }),
    );
    expect(dimensionLabel).toMatch(/tool.timeout/i);
    expect(evidence).toContain('5 min limit, ran 6 min');
    expect(evidence).toContain('npm test');
  });

  it('guards an unknown dimension gracefully instead of throwing', () => {
    const { dimensionLabel, evidence } = describeGuardrailTrip(
      event({ dimension: 'made-up' as GuardrailEvent['dimension'], limitValue: 3, observedValue: 9 }),
    );
    expect(dimensionLabel).toBe('made-up');
    expect(evidence).toBe('limit 3, observed 9');
  });
});

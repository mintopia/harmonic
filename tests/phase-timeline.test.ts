import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../web/src/components/PhaseTimeline.tsx', import.meta.url)),
  'utf8',
);

describe('PhaseTimeline', () => {
  it('labels landing as merging and never speaks a review phase (ADR-0041 deleted the gate)', () => {
    expect(SOURCE).toContain("landing: 'Merging'");
    expect(SOURCE).not.toContain("'review'");
    expect(SOURCE).not.toContain('bg-await-dot');
  });

  it('marks the current phase in the action accent, pulsing', () => {
    expect(SOURCE).toContain("if (step.status === 'current') return 'bg-accent motion-safe:animate-pulse';");
    expect(SOURCE).toContain("if (step.status === 'current') return 'text-accent';");
  });
});

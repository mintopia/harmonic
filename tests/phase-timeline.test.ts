import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../web/src/components/PhaseTimeline.tsx', import.meta.url)),
  'utf8',
);

describe('PhaseTimeline', () => {
  it('uses indigo for the current review phase and labels landing as merging', () => {
    expect(SOURCE).toContain("step.phase === 'review' ? 'bg-await-dot'");
    expect(SOURCE).toContain("step.phase === 'review' ? 'text-await'");
    expect(SOURCE).toContain("landing: 'Merging'");
  });
});

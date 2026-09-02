import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The JSX surfaces can't be imported into the node test project.
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Epic integrate.held surfacing', () => {
  it('renders the held Epic as an escalated (indigo) card in the Board\'s Attention section', () => {
    const board = source('web/src/components/Board.tsx');
    expect(board).toContain('function EpicAttentionCard');
    expect(board).toContain("stateFill('escalated')");
    expect(board).toContain("stateChip('escalated')");
    expect(board).toContain('{epic.integrate.held}');
  });

  it('surfaces a held whole-Epic merge on the summary-page stepper, not a force-merge button (ADR-0017)', () => {
    const model = source('web/src/epic-model.ts');
    const page = source('web/src/components/EpicPage.tsx');
    expect(model).toContain('held — ');
    expect(page).toContain('<EpicStepper epic={epic} />');
    expect(page).not.toContain('Force-merge');
  });
});

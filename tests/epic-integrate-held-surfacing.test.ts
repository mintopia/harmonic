import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-contract tests (same approach as paper-a11y.test.ts): Board.tsx
// carries JSX and can't be imported into the node test project, so assert the
// held-merge surfacing against its source. The Attention-section promotion
// itself is proven in board-sections-model.test.ts.
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Epic integrate.held surfacing', () => {
  it('renders the held Epic as an escalated (indigo) card in the Board\'s Attention section', () => {
    const board = source('web/src/components/Board.tsx');
    expect(board).toContain('function EpicAttentionCard');
    // The escalated state's own colour, never a borrowed register.
    expect(board).toContain("stateFill('escalated')");
    expect(board).toContain("stateChip('escalated')");
    // The held reason is the card's escalation line.
    expect(board).toContain('{epic.integrate.held}');
  });

  it('shows the held reason next to the Force-merge control on the focused Epic board', () => {
    const board = source('web/src/components/Board.tsx');
    expect(board).toContain('epic.integrate.held != null');
    expect(board).toContain('Merge escalated — awaiting you.');
    expect(board).toContain('{epic.integrate.held}');
    expect(board).toContain('Force-merge ready subset');
  });
});

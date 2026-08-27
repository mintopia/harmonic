import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-contract tests (same approach as paper-a11y.test.ts): Board.tsx and
// EpicPeek.tsx carry JSX and can't be imported into the node test project, so
// assert the held-merge surfacing against their source. The Attention-section
// promotion itself is proven in board-sections-model.test.ts.
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

  it('shows the held reason next to the Force-merge control in the peek', () => {
    const peek = source('web/src/components/EpicPeek.tsx');
    expect(peek).toContain('epic.integrate.held != null');
    expect(peek).toContain('Merge escalated — awaiting you.');
    // The reason is rendered as detail, alongside the existing Force-merge control.
    expect(peek).toContain('{epic.integrate.held}');
    expect(peek).toContain('Force-merge ready subset');
  });
});

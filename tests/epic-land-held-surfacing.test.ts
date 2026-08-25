import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-contract tests (same approach as paper-a11y.test.ts): Board.tsx and
// EpicPeek.tsx carry JSX and can't be imported into the node test project, so
// assert the held-merge surfacing against their source. The board-drop half of
// the fix is proven by render logic in board-sections-model.test.ts.
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Epic land.held surfacing', () => {
  it('surfaces the held merge as an amber escalation chip on the Board band', () => {
    const board = source('web/src/components/Board.tsx');
    expect(board).toContain('epic.land.held != null');
    expect(board).toContain('Merge escalated — needs you');
    // Reuses the established escalation register (amber), not a new colour.
    expect(board).toContain('bg-running-tint text-running');
    // The held reason rides along as the chip's hover detail.
    expect(board).toContain('title={epic.land.held}');
  });

  it('shows the held reason next to the Force-merge control in the peek', () => {
    const peek = source('web/src/components/EpicPeek.tsx');
    expect(peek).toContain('epic.land.held != null');
    expect(peek).toContain('Merge escalated — awaiting you.');
    // The reason is rendered as detail, alongside the existing Force-merge control.
    expect(peek).toContain('{epic.land.held}');
    expect(peek).toContain('Force-merge ready subset');
  });
});

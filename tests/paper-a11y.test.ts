import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Paper accessibility contract (issue #266)', () => {
  it('announces task state, the needs-you count, and merge outcomes', () => {
    const app = source('web/src/App.tsx');
    const board = source('web/src/components/Board.tsx');
    const epicPeek = source('web/src/components/EpicPeek.tsx');
    const toasts = source('web/src/toast.tsx');

    expect(app).toContain('setStateAnnouncement');
    expect(app).toContain('Needs you: {needsYouCount}');
    expect(board).toContain("aria-live={attn ? 'polite' : undefined}");
    expect(epicPeek).toContain('aria-live="assertive"');
    expect(toasts).toContain('aria-live="assertive"');
  });

  it('keeps state dots named and compact controls touchable', () => {
    const board = source('web/src/components/Board.tsx');
    const rail = source('web/src/components/ticket/RunRail.tsx');
    const gate = source('web/src/components/ticket/Gate.tsx');
    const ui = source('web/src/ui.ts');

    expect(board).toContain('role="img" aria-label={task.state.replaceAll');
    expect(rail).toContain('role="img"');
    expect(gate).toContain('role="img" aria-label={DOT_LABEL[model.dot]}');
    expect(rail).toContain('min-h-11 w-full');
    expect(ui).toContain("export const btnQuiet = 'inline-flex min-h-11");
  });

  it('provides a reduced-motion alternative for shared animations', () => {
    const css = source('web/src/index.css');

    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.animate-dot-pulse');
    expect(css).toContain('animation: none;');
  });
});

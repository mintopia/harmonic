import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Paper accessibility contract (issue #266)', () => {
  it('announces task state, the needs-you count, and merge outcomes', () => {
    const app = source('web/src/App.tsx');
    const board = source('web/src/components/Board.tsx');
    const toasts = source('web/src/toast.tsx');

    expect(app).toContain('advanceReviewAnnouncements');
    expect(board).toContain("aria-live={attn ? 'polite' : undefined}");
    expect(board).toContain('aria-live="assertive"');
    expect(toasts).toContain('aria-live="assertive"');
  });

  it('keeps state dots named and compact controls touchable', () => {
    const board = source('web/src/components/Board.tsx');
    const timeline = source('web/src/components/ticket/AttemptTimeline.tsx');
    const gate = source('web/src/components/ticket/Gate.tsx');
    const ui = source('web/src/ui.ts');

    expect(board).toContain('role="img" aria-label={task.state.replaceAll');
    expect(timeline).toContain('role="img" aria-label={attempt.state}');
    expect(timeline).toContain('role="img" aria-label={task.state}');
    expect(gate).toContain('role="img" aria-label={DOT_LABEL[model.dot]}');
    expect(timeline).not.toMatch(/min-h-(?:[0-9]|10)\b/);
    expect(timeline).toContain('min-h-11 items-center');
    expect(ui).toContain("export const btnQuiet = 'inline-flex min-h-11");
  });

  it('provides a reduced-motion alternative for shared animations', () => {
    const css = source('web/src/index.css');

    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.animate-dot-pulse');
    expect(css).toContain('animation: none;');
  });
});

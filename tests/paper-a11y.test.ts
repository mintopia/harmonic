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
    expect(toasts).toContain('aria-live="assertive"');
  });

  it('keeps state dots named and compact controls touchable', () => {
    const board = source('web/src/components/Board.tsx');
    const ticket = source('web/src/components/TicketPage.tsx');
    const gate = source('web/src/components/ticket/Gate.tsx');
    const ui = source('web/src/ui.ts');

    expect(board).toContain('role="img" aria-label={task.state.replaceAll');
    expect(ticket).toContain('role="img" aria-label={attempt.state}');
    expect(ui).toContain("export const railNavButton = 'flex min-h-11 w-full items-center");
    expect(gate).toContain('role="img" aria-label={DOT_LABEL[model.dot]}');
    expect(ui).toContain("export const btnQuiet = 'inline-flex min-h-11");
  });

  it('provides a reduced-motion alternative for shared animations', () => {
    const css = source('web/src/index.css');

    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.animate-dot-pulse');
    expect(css).toContain('animation: none;');
  });

  it('names the Epic token bar, exposes the description toggle state, and keeps the harness chip a single tint', () => {
    const epicPage = source('web/src/components/EpicPage.tsx');
    const taskIdentity = source('web/src/components/TaskIdentity.ts');

    expect(epicPage).toMatch(/role="img"[^>]*aria-label=\{title\}/);
    expect(epicPage).toContain('aria-expanded={expanded}');
    expect(taskIdentity).not.toMatch(/bg-tool\/\d/);
  });

  it('shares app refresh with Board actions and detail-page facts', () => {
    const app = source('web/src/App.tsx');
    const board = source('web/src/components/Board.tsx');
    const ticket = source('web/src/components/TicketPage.tsx');
    const epic = source('web/src/components/EpicPage.tsx');

    expect(app).toContain('<AppContextProvider value={{ config, workspace: activeWorkspace, refresh }}>');
    expect(board).toContain("import { useAppContext } from '../app-context';");
    expect(board).not.toContain('onChanged: () => void;');
    expect(ticket).toContain("import { Fact } from './Fact';");
    expect(epic).toContain("import { Fact } from './Fact';");
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Paper accessibility contract (issue #266)', () => {
  it('announces task state, the needs-you count, and merge outcomes', () => {
    const appSync = source('web/src/useAppSync.ts');
    const board = source('web/src/components/Board.tsx');
    const toasts = source('web/src/toast.tsx');

    expect(appSync).toContain('advanceReviewAnnouncements');
    expect(board).toContain("aria-live={attn ? 'polite' : undefined}");
    expect(toasts).toContain("aria-live={success ? 'polite' : 'assertive'}");
  });

  it('keeps state dots named and compact controls touchable', () => {
    const board = source('web/src/components/Board.tsx');
    const attemptsNav = source('web/src/components/ticket/AttemptsNav.tsx');
    const gate = source('web/src/components/ticket/Gate.tsx');
    const ui = source('web/src/ui.ts');

    expect(board).toContain('role="img" aria-label={task.state.replaceAll');
    expect(attemptsNav).toContain('role="img" aria-label={attempt.state}');
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
    const metrics = source('web/src/components/ticket/Metrics.tsx');
    const epic = source('web/src/components/EpicPage.tsx');

    expect(app).toContain('<AppContextProvider value={{ config, workspace: activeWorkspace, refresh }}>');
    expect(board).toContain("import { useAppContext } from '../app-context';");
    expect(board).not.toContain('onChanged: () => void;');
    expect(metrics).toContain("import { Fact } from '../Fact';");
    expect(epic).toContain("import { Fact } from './Fact';");
  });

  it('announces the wall-clock overdue transition without making the countdown itself live', () => {
    const metrics = source('web/src/components/ticket/Metrics.tsx');

    expect(metrics).toContain('aria-live="polite"');
    expect(metrics).toContain('Time limit reached');
  });

  it('keeps source-control actions labelled, touchable, and confirmation-gated', () => {
    const files = source('web/src/components/FilesPage.tsx');

    expect(files).toContain('aria-labelledby="source-control-title"');
    expect(files).toContain('label="Staged"');
    expect(files).toContain('label="Changes"');
    expect(files).toContain('htmlFor="commit-message"');
    expect(files).toContain('min-h-11');
    expect(files).toContain('<ConfirmDialog');
    expect(files).toContain('title="Discard changes?"');
  });

  it('gives every error surface an accessible role and never a blank crash screen', () => {
    const errorBoundary = source('web/src/components/ErrorBoundary.tsx');
    const connectionBanner = source('web/src/components/ConnectionBanner.tsx');
    const appContent = source('web/src/components/AppContent.tsx');
    const epicPage = source('web/src/components/EpicPage.tsx');
    const login = source('web/src/components/Login.tsx');
    const fieldError = source('web/src/components/SettingsSection.tsx');

    expect(errorBoundary).toContain('role="alert"');
    expect(connectionBanner).toContain('role="status"');
    expect(connectionBanner).toContain('aria-live="polite"');
    expect(appContent).toContain('title="Task not found"');
    expect(epicPage).toContain('title="Epic not found"');
    expect(login).toContain("Couldn't reach Harmonic");
    expect(fieldError).toContain('export function FieldError({ message }: { message?: string }) {\n  if (!message) return null;\n  return <p role="alert"');
  });
});

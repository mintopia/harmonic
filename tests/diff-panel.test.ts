import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiffViewer } from '../web/src/components/DiffViewer.js';

const TICKET_PAGE = readFileSync(fileURLToPath(new URL('../web/src/components/TicketPage.tsx', import.meta.url)), 'utf8');
const CHANGES_PANE = readFileSync(fileURLToPath(new URL('../web/src/components/ticket/ChangesPane.tsx', import.meta.url)), 'utf8');
const DIFF_VIEWER = readFileSync(fileURLToPath(new URL('../web/src/components/DiffViewer.tsx', import.meta.url)), 'utf8');

describe('single-file diff panel', () => {
  it('titles the panel by the filename and shows the ± summary and full path', () => {
    expect(CHANGES_PANE).toContain('splitPathTail(selectedFile).tail');
    expect(CHANGES_PANE).toMatch(/\+\{file\.additions\}/);
    expect(CHANGES_PANE).toMatch(/−\{file\.deletions\}/);
  });

  it('renders the hunks with the repeated path/count strip dropped', () => {
    expect(CHANGES_PANE).toContain('<DiffViewer file={file} headerless />');
    expect(DIFF_VIEWER).toContain('headerless');
  });

  it('reads the run-agnostic worktree diff, not the selected Attempt', () => {
    expect(TICKET_PAGE).toContain('attemptId={latestAttemptId}');
  });

  it('highlights code in diff bodies', () => {
    const html = renderToStaticMarkup(
      createElement(DiffViewer, {
        file: {
          path: 'src/example.ts',
          status: 'M',
          additions: 1,
          deletions: 0,
          lines: [{ kind: 'add', oldLn: null, newLn: 1, text: 'const answer = 42;' }],
        },
      }),
    );

    expect(html).toContain('hljs-keyword');
  });
});

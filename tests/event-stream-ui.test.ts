import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../web/src/components/Markdown.js', () => ({
  Markdown: ({ source }: { source: string }) => source,
}));

import { EventStream } from '../web/src/components/conversation/EventStream.js';
import type { StreamEvent } from '../web/src/event-stream-model.js';

const tool = (id: number, payload: Record<string, unknown>): StreamEvent => ({
  id,
  seq: id,
  ts: id,
  type: 'session_update',
  payload: { sessionUpdate: 'tool_call', toolCallId: `tool-${id}`, ...payload },
});

const render = (events: StreamEvent[]) => renderToStaticMarkup(createElement(EventStream, { events }));

describe('EventStream tool cards (#549)', () => {
  it('renders an execute call as a terminal with its command, streamed output, and completed state', () => {
    const html = render([tool(1, {
      kind: 'execute',
      title: 'Run tests',
      status: 'completed',
      rawInput: { command: 'npm test' },
      content: [{ content: { text: '12 tests passed' } }],
    })]);

    expect(html).toContain('npm test');
    expect(html).toContain('12 tests passed');
    expect(html).toContain('aria-label="completed"');
  });

  it('renders a read call as a file card with its path and line range', () => {
    const html = render([tool(1, {
      kind: 'read',
      title: 'Read source',
      status: 'pending',
      rawInput: { path: 'src/app.ts', lineStart: 4, lineEnd: 12 },
    })]);

    expect(html).toContain('src/app.ts');
    expect(html).toContain('lines 4–12');
    expect(html).toContain('aria-label="running"');
  });

  it('renders an edit with an ACP diff block as a unified diff card', () => {
    const html = render([tool(1, {
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: 'src/app.ts', oldText: 'before\n', newText: 'after\n' }],
    })]);

    expect(html).toContain('Changed file');
    expect(html).toContain('src/app.ts');
    expect(html).toContain('before');
    expect(html).toContain('after');
    expect(html).toContain('aria-label="completed"');
  });

  it('renders a diff card when a harness omits the edit kind', () => {
    const html = render([tool(1, {
      content: [{ type: 'diff', path: 'src/app.ts', oldText: 'before\n', newText: 'after\n' }],
    })]);

    expect(html).toContain('Changed file');
    expect(html).toContain('src/app.ts');
  });

  it('keeps an edit without a diff as the expandable raw detail view', () => {
    const html = render([tool(1, {
      kind: 'edit',
      title: 'Edit src/app.ts',
      rawInput: { path: 'src/app.ts' },
      content: [{ content: { text: 'Updated file' } }],
    })]);

    expect(html).toContain('<details');
    expect(html).toContain('Raw input &amp; output');
    expect(html).toContain('Updated file');
  });

  it.each(['search', 'fetch', 'think', 'delete', 'move', 'other'])('keeps %s as a compact expandable summary with raw details', (kind) => {
    const html = render([tool(1, {
      kind,
      title: 'Find matching files',
      status: 'failed',
      rawInput: { query: 'ToolCard' },
      content: [{ content: { text: 'No matches' } }],
    })]);

    expect(html).toContain('<details');
    expect(html).toContain('Find matching files');
    expect(html).toContain('ToolCard');
    expect(html).toContain('No matches');
    expect(html).toContain('aria-label="failed"');
  });
});

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

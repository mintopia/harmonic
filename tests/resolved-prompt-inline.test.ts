// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResolvedPromptInline } from '../web/src/components/ticket/ResolvedPromptInline.js';
import { chatRows } from '../web/src/attempt-chat-model.js';
import type { AttemptLogEvent } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(cleanup);

const reply = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });
const mount = (props: Partial<Parameters<typeof ResolvedPromptInline>[0]> = {}) =>
  mountComponent(createElement(ResolvedPromptInline, { owner: { attemptId: 7 }, locator: 'a/b.jsonl', index: 2, label: 'Commit nudge', ...props }));

describe('ResolvedPromptInline', () => {
  it('shows a loading state, then the blob verbatim under a Prompt sent label', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    const host = await mount();
    expect(host.textContent).toContain('Loading sent prompt');
    await act(async () => release(reply(200, 'Commit the work.\n  indented <b>raw</b>')));
    expect(host.textContent).toContain('Prompt sent · Commit nudge');
    expect(host.querySelector('pre')?.textContent).toBe('Commit the work.\n  indented <b>raw</b>');
    expect(host.querySelector('button')).toBeNull();
  });

  it('requests the route with the locator and prompt index', async () => {
    fetchMock.mockResolvedValue(reply(200, 'x'));
    await mount();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/attempts/7/resolved-prompt?locator=a%2Fb.jsonl&index=2');
  });

  it('requests the Epic-scoped route when the Epic has no Attempt row', async () => {
    fetchMock.mockResolvedValue(reply(200, 'x'));
    await mount({ owner: { workspaceId: 3, epicRef: '42', attempt: 1 } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspaces/3/epics/42/resolved-prompt?attempt=1&locator=a%2Fb.jsonl&index=2');
  });

  it('says the prompt is not archived on a 404', async () => {
    fetchMock.mockResolvedValue(reply(404, 'nope'));
    const host = await mount();
    expect(host.textContent).toContain('Prompt not archived');
    expect(host.querySelector('pre')).toBeNull();
  });

  it('collapses a long prompt behind an expand control', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line number ${i} of the long prompt`).join('\n');
    fetchMock.mockResolvedValue(reply(200, long));
    const host = await mount();
    const toggle = host.querySelector('button') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('pre')?.className).toContain('line-clamp-');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Show less');
    expect(host.querySelector('pre')?.className).not.toContain('line-clamp-');
    expect(host.querySelector('pre')?.textContent).toBe(long);
  });

  it('collapses a long single-line prompt too', async () => {
    fetchMock.mockResolvedValue(reply(200, 'word '.repeat(200)));
    const host = await mount();
    expect(host.querySelector('button')).not.toBeNull();
  });
});

describe('chatRows resolved-prompt rows', () => {
  const lifecycle = (event: string, extra: Record<string, unknown>, id: number) => ({
    kind: 'event' as const,
    key: id,
    event: { id, seq: id, ts: id, type: 'lifecycle', payload: { event, ...extra } } as unknown as AttemptLogEvent,
  });

  it('labels each resolver prompt-sending lifecycle event plainly', () => {
    const rows = chatRows([
      lifecycle('merge-conflict-resolve', { locator: 'l', promptIndex: 2 }, 3),
      lifecycle('epic-resolve', { kind: 'refresh', locator: 'l', promptIndex: 3 }, 4),
      lifecycle('epic-resolve', { kind: 'verification', locator: 'l', promptIndex: 4 }, 5),
    ]);
    expect(rows.map((r) => (r.kind === 'resolved-prompt' ? [r.label, r.index] : null))).toEqual([
      ['Merge conflict resolver', 2],
      ['Epic refresh resolver', 3],
      ['Epic verification resolver', 4],
    ]);
  });

  it('shows each continue/commit nudge once: as a plain marker, since its text renders as the turn prompt', () => {
    const rows = chatRows([
      lifecycle('continue', { attempt: 1, locator: 'implementation/prompt.md', promptIndex: 1 }, 1),
      lifecycle('commit-nudge', { locator: 'implementation/prompt.md', promptIndex: 2 }, 2),
    ]);
    expect(rows).toEqual([
      { kind: 'note', label: 'continue', text: null, key: 1 },
      { kind: 'note', label: 'commit-nudge', text: null, key: 2 },
    ]);
  });
});

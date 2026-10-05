// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from '../web/src/components/ticket/ChatTranscript.js';
import { useTurnPrompts } from '../web/src/components/ticket/useTurnPrompts.js';
import type { AttemptLogEvent } from '../web/src/types.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

const { attemptResolvedPrompts, resolvedPrompt } = vi.hoisted(() => ({
  attemptResolvedPrompts: vi.fn(),
  resolvedPrompt: vi.fn(),
}));
vi.mock('../web/src/api.js', () => ({ api: { attemptResolvedPrompts, resolvedPrompt } }));

const ev = (id: number, payload: Record<string, unknown>, type = 'session_update'): AttemptLogEvent => ({
  id,
  seq: id,
  ts: id * 1000,
  type: type as 'session_update',
  payload: payload as AttemptLogEvent['payload'],
});
const say = (id: number, text: string) => ev(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const finished = (id: number) => ev(id, { event: 'finished' }, 'lifecycle');
const sent = (id: number) => ev(id, { event: 'prompt_sent' }, 'lifecycle');

afterEach(cleanup);

function chat(events: AttemptLogEvent[], turnPrompts: string[]) {
  return createElement(ChatTranscript, { events, unavailable: false, model: 'm', agent: 'Claude', turnPrompts });
}

describe('per-turn Resolved Prompts in the transcript', () => {
  it('renders each later prompt before the reply it triggered, several per cycle before one finished', async () => {
    const host = await mountComponent(
      chat(
        [sent(1), say(2, 'reply one'), sent(3), say(4, 'reply two'), sent(5), say(6, 'reply three'), finished(7), sent(8), say(9, 'reply nudge'), finished(10)],
        ['steer: use the cache', 'continue the work', 'commit your changes'],
      ),
    );
    const text = host.textContent ?? '';
    const order = ['reply one', 'steer: use the cache', 'reply two', 'continue the work', 'reply three', 'commit your changes', 'reply nudge'];
    const positions = order.map((part) => text.indexOf(part));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain('Prompt sent · turn 4');
    expect(text).not.toContain('prompt_sent');
  });

  it('lists prompts in order at the end when the stream has no turn boundaries', async () => {
    const host = await mountComponent(chat([say(1, 'only reply')], ['second', 'third']));
    const text = host.textContent ?? '';
    expect(text.indexOf('only reply')).toBeLessThan(text.indexOf('second'));
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'));
    expect(text).toContain('Prompt sent · turn 3');
  });

  it('shows no prompt block when none were archived', async () => {
    const host = await mountComponent(chat([sent(1), say(2, 'reply'), finished(3), say(4, 'more')], []));
    expect(host.textContent).not.toContain('Prompt sent');
  });
});

describe('useTurnPrompts', () => {
  it('keeps a first prompt containing a rule whole and the later prompts in place', async () => {
    const first = 'Ticket body\n\n---\n\nmore body';
    attemptResolvedPrompts.mockResolvedValue([first, 'second']);
    const Probe = () => createElement('pre', null, JSON.stringify(useTurnPrompts(9, 1)));
    const host = await mountComponent(createElement(Probe));
    await flush();
    expect(attemptResolvedPrompts).toHaveBeenCalledWith(9, 'implementation/prompt.md');
    expect(JSON.parse(host.textContent ?? '[]')).toEqual([first, 'second']);
  });

  it('reads only the newly sent prompts after the first load, and keeps what it holds when a read fails', async () => {
    attemptResolvedPrompts.mockReset();
    resolvedPrompt.mockReset();
    attemptResolvedPrompts.mockResolvedValue(['zero', 'one']);
    resolvedPrompt.mockImplementation(async (_owner: unknown, _locator: string, index: number) => (index === 3 ? Promise.reject(new Error('gone')) : `turn ${index}`));
    let setSent: (count: number) => void = () => {};
    const Probe = () => {
      const [sent, set] = useState(2);
      useEffect(() => {
        setSent = set;
      }, [set]);
      return createElement('pre', null, JSON.stringify(useTurnPrompts(9, sent)));
    };
    const host = await mountComponent(createElement(Probe));
    await flush();
    expect(JSON.parse(host.textContent ?? '[]')).toEqual(['zero', 'one']);

    await act(async () => { setSent(3); await flush(); });
    expect(attemptResolvedPrompts).toHaveBeenCalledTimes(1);
    expect(resolvedPrompt.mock.calls).toEqual([[{ attemptId: 9 }, 'implementation/prompt.md', 2]]);
    expect(JSON.parse(host.textContent ?? '[]')).toEqual(['zero', 'one', 'turn 2']);

    await act(async () => { setSent(5); await flush(); });
    expect(resolvedPrompt.mock.calls.slice(1).map((call) => call[2])).toEqual([3]);
    expect(JSON.parse(host.textContent ?? '[]')).toEqual(['zero', 'one', 'turn 2']);
  });
});

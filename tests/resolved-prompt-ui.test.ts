// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from '../web/src/components/ticket/ChatTranscript.js';
import { EpicTimeline } from '../web/src/components/EpicTimeline.js';
import type { Epic } from '../web/src/epic-model.js';
import type { AttemptLogEvent } from '../web/src/types.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

const { epicRefreshPrompts, epicRefreshPrompt } = vi.hoisted(() => ({
  epicRefreshPrompts: vi.fn(),
  epicRefreshPrompt: vi.fn(),
}));
vi.mock('../web/src/api.js', () => ({ api: { epicRefreshPrompts, epicRefreshPrompt } }));

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

describe('epic refresh resolver prompts', () => {
  const epic = { ref: '701', title: 't', kind: 'spec', state: 'open', timelineEvents: [], mergeSteps: [], createdAt: 1_000, updatedAt: null, members: [] } as unknown as Epic;

  it('lists each prompt collapsed and reads its text from the Archive only when opened', async () => {
    epicRefreshPrompts.mockResolvedValue({ prompts: [{ locator: 'refresh/r1/prompt.md', at: '2026-10-05T10:00:00.000Z' }] });
    epicRefreshPrompt.mockResolvedValue('Refresh the epic exactly like this.');
    const host = await mountComponent(createElement(EpicTimeline, { epic, workspaceId: 3 }));

    const details = host.querySelector('details');
    expect(details?.textContent).toContain('Refresh resolver prompt');
    expect(epicRefreshPrompt).not.toHaveBeenCalled();

    if (!details) throw new Error('missing details');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await flush();
    expect(epicRefreshPrompt).toHaveBeenCalledWith(3, '701', 'refresh/r1/prompt.md');
    expect(host.textContent).toContain('Refresh the epic exactly like this.');
  });

  it('renders nothing extra when no refresh prompts exist', async () => {
    epicRefreshPrompts.mockResolvedValue({ prompts: [] });
    const host = await mountComponent(createElement(EpicTimeline, { epic, workspaceId: 3 }));
    expect(host.querySelector('details')).toBeNull();
  });
});

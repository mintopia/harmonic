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

afterEach(cleanup);

function chat(events: AttemptLogEvent[], turnPrompts: string[]) {
  return createElement(ChatTranscript, { events, unavailable: false, model: 'm', agent: 'Claude', turnPrompts });
}

describe('per-turn Resolved Prompts in the transcript', () => {
  it('renders each later turn prompt verbatim between the turns it separates', async () => {
    const host = await mountComponent(
      chat([say(1, 'turn one reply'), finished(2), say(3, 'turn two reply')], ['Continue: commit the work.']),
    );
    const text = host.textContent ?? '';
    expect(text).toContain('Prompt sent · turn 2');
    expect(text.indexOf('turn one reply')).toBeLessThan(text.indexOf('Continue: commit the work.'));
    expect(text.indexOf('Continue: commit the work.')).toBeLessThan(text.indexOf('turn two reply'));
  });

  it('lists prompts in order at the end when the stream has no turn boundaries', async () => {
    const host = await mountComponent(chat([say(1, 'only reply')], ['second', 'third']));
    const text = host.textContent ?? '';
    expect(text.indexOf('only reply')).toBeLessThan(text.indexOf('second'));
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'));
    expect(text).toContain('Prompt sent · turn 3');
  });

  it('shows no prompt block when none were archived', async () => {
    const host = await mountComponent(chat([say(1, 'reply'), finished(2), say(3, 'more')], []));
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

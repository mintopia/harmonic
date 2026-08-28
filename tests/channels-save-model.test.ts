import { describe, expect, it } from 'vitest';
import { changedChannelEvents, channelsDirty, toggleChannelEvent } from '../web/src/channels-save-model.js';
import type { Channel } from '../web/src/types.js';

const channel = (id: number, events: string[] = []): Channel => ({
  id,
  name: `channel ${id}`,
  type: 'discord',
  config: { url: 'https://example.test' },
  events,
});

describe('toggleChannelEvent', () => {
  it('adds an event when absent and removes it when present', () => {
    const list = [channel(1, [])];
    const added = toggleChannelEvent(list, 1, 'task.done');
    expect(added[0]!.events).toEqual(['task.done']);
    const removed = toggleChannelEvent(added, 1, 'task.done');
    expect(removed[0]!.events).toEqual([]);
  });

  it('leaves other channels untouched', () => {
    const list = [channel(1, []), channel(2, ['run.started'])];
    const next = toggleChannelEvent(list, 1, 'task.done');
    expect(next[1]).toBe(list[1]);
  });

  it('does not mutate the input list', () => {
    const list = [channel(1, [])];
    toggleChannelEvent(list, 1, 'task.done');
    expect(list[0]!.events).toEqual([]);
  });
});

describe('channelsDirty / changedChannelEvents', () => {
  it('is clean when nothing changed', () => {
    const pristine = [channel(1, ['task.done'])];
    expect(channelsDirty(pristine, pristine)).toBe(false);
    expect(changedChannelEvents(pristine, pristine)).toEqual([]);
  });

  it('flags only the channel whose events changed, with the new events', () => {
    const pristine = [channel(1, []), channel(2, ['run.started'])];
    const local = toggleChannelEvent(pristine, 1, 'task.done');
    expect(channelsDirty(local, pristine)).toBe(true);
    expect(changedChannelEvents(local, pristine)).toEqual([{ id: 1, events: ['task.done'] }]);
  });

  it('treats a reordered subscription list as unchanged', () => {
    const pristine = [channel(1, ['a', 'b'])];
    const local = [channel(1, ['b', 'a'])];
    expect(channelsDirty(local, pristine)).toBe(false);
  });

  it('ignores channels missing from pristine (added ones are already synced)', () => {
    const pristine = [channel(1, [])];
    const local = [channel(1, []), channel(2, ['queue.idle'])];
    expect(changedChannelEvents(local, pristine)).toEqual([]);
  });
});

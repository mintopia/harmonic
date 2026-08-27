// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { Channel } from './types.js';

// Editing which events a channel receives is a config *value*: it buffers into
// the settings save bar (ADR-0044 G) rather than persisting on every click.
// Creating or deleting a channel stays an immediate side-effect action.
export function toggleChannelEvent(channels: Channel[], id: number, event: string): Channel[] {
  return channels.map((channel) =>
    channel.id === id
      ? {
          ...channel,
          events: channel.events.includes(event)
            ? channel.events.filter((e) => e !== event)
            : [...channel.events, event],
        }
      : channel,
  );
}

// The channels whose event subscriptions diverge from their saved form — the set
// the save bar must PATCH. Add/delete keep both lists in sync, so only an event
// edit can diverge. Order-insensitive: toggling appends, but a subscription is a
// set, so a reordered list is not a change.
export function changedChannelEvents(
  local: Channel[],
  pristine: Channel[],
): Array<{ id: number; events: string[] }> {
  const saved = new Map(pristine.map((channel) => [channel.id, channel.events]));
  const changed: Array<{ id: number; events: string[] }> = [];
  for (const channel of local) {
    const before = saved.get(channel.id);
    if (before && !sameEvents(before, channel.events)) {
      changed.push({ id: channel.id, events: channel.events });
    }
  }
  return changed;
}

export function channelsDirty(local: Channel[], pristine: Channel[]): boolean {
  return changedChannelEvents(local, pristine).length > 0;
}

function sameEvents(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((event) => set.has(event));
}

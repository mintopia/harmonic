// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import { isInterrupted, movingBaseView, type StreamItem } from './event-stream-model.js';
import type { AttemptLogEvent } from './types.js';

/**
 * The Attempt transcript rendered as a chat (the Claude-Desktop register): the
 * agent's turns as assistant messages, the operator's steer turns as "You"
 * messages folded in at the point they were sent, its private reasoning as quiet
 * thought blocks, and every tool call as one compact card. This module is the
 * pure seam — {@link chatRows} classifies the already-coalesced stream items so
 * the component stays a thin renderer, unit-tested away from the DOM.
 */
export type ChatRow =
  | { kind: 'message'; author: 'assistant' | 'operator'; text: string; at: number; key: number }
  | { kind: 'thought'; text: string; key: number }
  | { kind: 'tool'; verb: string; target: string | null; status: ChatToolStatus; subagent: boolean; output: string | null; at: number; key: number }
  | { kind: 'note'; label: string; text: string | null; key: number };

/** A tool card's outcome badge — settled ok / failed, or still in flight. */
export type ChatToolStatus = 'pending' | 'ok' | 'failed';

function toolStatus(status: string | undefined): ChatToolStatus {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'failed';
  return 'pending';
}

function splitTitle(title: string): { verb: string; target: string | null } {
  const trimmed = title.trim();
  const space = trimmed.indexOf(' ');
  if (space === -1) return { verb: trimmed || 'Tool call', target: null };
  return { verb: trimmed.slice(0, space), target: trimmed.slice(space + 1).trim() || null };
}

function eventRow(item: Extract<StreamItem<AttemptLogEvent>, { kind: 'event' }>): ChatRow | null {
  const movingBase = movingBaseView(item.event.payload);
  if (movingBase) {
    return { kind: 'note', label: 'Reconciling', text: movingBase.count ? `${movingBase.label} ${movingBase.count}` : movingBase.label, key: item.key };
  }
  if (isInterrupted(item.event.payload)) {
    return { kind: 'note', label: 'Interrupted', text: null, key: item.key };
  }
  const payload = item.event.payload as { event?: unknown; text?: unknown } | null;
  const label = typeof payload?.event === 'string' ? payload.event : item.event.type;
  const text = typeof payload?.text === 'string' && payload.text.trim() ? payload.text : null;
  if (!text && label === item.event.type) return null;
  return { kind: 'note', label, text, key: item.key };
}

/**
 * Map coalesced transcript stream items to chat rows. Empty-text message and
 * thought items (a chunk that folded to nothing) are dropped so they leave no
 * blank bubble; tool calls fold to a single card whose status advances in
 * place; unremarkable lifecycle heartbeats are elided.
 */
export function chatRows(items: readonly StreamItem<AttemptLogEvent>[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      if (!item.text.trim()) continue;
      if (item.variant === 'operator') {
        rows.push({ kind: 'message', author: 'operator', text: item.text, at: item.at, key: item.key });
      } else if (item.variant === 'thought') {
        rows.push({ kind: 'thought', text: item.text, key: item.key });
      } else {
        rows.push({ kind: 'message', author: 'assistant', text: item.text, at: item.at, key: item.key });
      }
      continue;
    }
    if (item.kind === 'tool') {
      const { verb, target } = splitTitle(item.tool.title ?? 'Tool call');
      rows.push({ kind: 'tool', verb, target, status: toolStatus(item.tool.status), subagent: item.tool.subagent, output: item.tool.output, at: item.at, key: item.key });
      continue;
    }
    const note = eventRow(item);
    if (note) rows.push(note);
  }
  return rows;
}

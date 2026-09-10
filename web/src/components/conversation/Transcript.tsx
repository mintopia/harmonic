import { useEffect, useRef, useState } from 'react';
import type { Conversation, ConversationEvent } from '../../types';
import { segmentTranscript } from '../../conversation-transcript-model';
import { coalesceEvents } from '../../event-stream-model';
import {
  announceTransitions,
  EMPTY_ANNOUNCE_CURSOR,
  type AnnounceCursor,
} from '../../stream-announce-model';
import { Icon } from '../Icon';
import { providerLabel } from '../TaskIdentity';
import { EventStream } from './EventStream';

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function agentMessageText(events: ConversationEvent[]): string {
  return coalesceEvents(events)
    .flatMap((item) => (item.kind === 'text' && item.variant === 'message' ? [item.text] : []))
    .join('\n\n');
}

function textFromPayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || !('text' in payload)) return '';
  return typeof payload.text === 'string' ? payload.text : '';
}

function CopyButton({ text, label, className = '' }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      onClick={copy}
      className={`inline-flex size-6 items-center justify-center rounded text-faint transition-colors duration-150 hover:text-ink ${copied ? 'text-merged' : ''} ${className}`}
    >
      <Icon name={copied ? 'check' : 'copy'} className="size-3.5" />
    </button>
  );
}

export function Transcript({ events, conversation }: { events: ConversationEvent[]; conversation: Conversation | null }) {
  const turns = segmentTranscript(events);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);

  if (turns.length === 0) {
    return <p className="text-muted">Send a message to begin.</p>;
  }

  const agentLabel = providerLabel(conversation?.harness ?? '');
  const model = conversation?.model ?? '';

  return (
    <div className="space-y-4">
      {turns.map((turn, i) => {
        const userText = textFromPayload(turn.userTurn?.payload);
        const agentText = agentMessageText(turn.agentEvents);
        const at = turn.agentEvents.at(-1)?.ts ?? turn.userTurn?.ts;
        return (
          <div key={turn.userTurn?.id ?? `pre-${i}`} className="space-y-3">
            {turn.userTurn && (
              <div className="group flex items-end justify-end gap-1.5">
                <CopyButton text={userText} label="Copy message" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
                <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-accent-tint px-3 py-2 text-ink">
                  {userText}
                </p>
              </div>
            )}
            {turn.agentEvents.length > 0 && (
              <div className="group flex gap-3">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-accent-tint text-[11px] font-bold text-accent">
                  {agentLabel.charAt(0)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-baseline gap-2">
                    <span className="text-[12.5px] font-semibold text-ink">{agentLabel}</span>
                    <span className="font-data text-[11px] text-faint">
                      {model}
                      {at ? ` · ${clockTime(at)}` : ''}
                    </span>
                    {agentText && (
                      <CopyButton
                        text={agentText}
                        label="Copy message"
                        className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      />
                    )}
                  </div>
                  <EventStream events={turn.agentEvents} />
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

export function StreamAnnouncer({
  events,
  resetKey,
}: {
  events: ConversationEvent[];
  resetKey: number | string;
}) {
  const cursor = useRef<AnnounceCursor>(EMPTY_ANNOUNCE_CURSOR);
  const seededFor = useRef<number | string | null>(null);
  const nextId = useRef(0);
  const [log, setLog] = useState<{ id: number; text: string }[]>([]);

  useEffect(() => {
    const items = coalesceEvents(events);
    if (seededFor.current !== resetKey) {
      cursor.current = announceTransitions(items, EMPTY_ANNOUNCE_CURSOR).cursor;
      seededFor.current = resetKey;
      setLog([]);
      return;
    }
    const { announcements, cursor: next } = announceTransitions(items, cursor.current);
    cursor.current = next;
    if (announcements.length === 0) return;
    setLog((prev) =>
      [...prev, ...announcements.map((text) => ({ id: nextId.current++, text }))].slice(-20),
    );
  }, [events, resetKey]);

  return (
    <div aria-live="polite" className="sr-only">
      {log.map((entry) => (
        <p key={entry.id}>{entry.text}</p>
      ))}
    </div>
  );
}

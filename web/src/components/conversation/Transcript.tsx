import { useEffect, useRef, useState } from 'react';
import type { Conversation, ConversationEvent } from '../../types';
import { segmentTranscript } from '../../conversation-transcript-model';
import { coalesceEvents, latestRunningTool } from '../../event-stream-model';
import { isAtLiveEdge } from '../../follow-tail-model';
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

// A locally-appended user turn we've optimistically shown before the server has
// echoed it back — see useConversationDetail's optimistic-send handling.
function isPendingTurn(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'pending' in payload &&
    (payload as { pending?: unknown }).pending === true
  );
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const runningTool = latestRunningTool(events);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && following) element.scrollTop = element.scrollHeight;
  }, [events, following]);

  useEffect(() => {
    setFollowing(true);
  }, [conversation?.id]);

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setFollowing(true);
  };

  const agentLabel = providerLabel(conversation?.harness ?? '');
  const userRoleLabel = 'text-label font-bold uppercase tracking-[0.09em] text-muted';
  const agentRoleLabel = 'text-label font-bold uppercase tracking-[0.09em] text-accent';

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        setFollowing(isAtLiveEdge(element));
      }}
      className="relative flex-1 overflow-y-auto bg-canvas"
    >
      {runningTool && (
        <div
          role="status"
          aria-live="polite"
          className="sticky top-0 z-10 flex min-h-9 min-w-0 items-center gap-2 border-b border-hairline bg-running-tint px-4 py-2 text-small backdrop-blur-sm"
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-running-dot motion-safe:animate-dot-pulse" />
          <span className="shrink-0 text-label font-bold uppercase tracking-[0.1em] text-running">Running</span>
          <span className="min-w-0 flex-1 truncate font-semibold text-ink">{runningTool.title ?? runningTool.toolKind ?? 'Tool call'}</span>
        </div>
      )}
      {turns.length === 0 ? <p className="p-4 text-muted">Send a message to begin.</p> : (
        <div className="mx-auto max-w-4xl px-4 py-5">
          {turns.map((turn, i) => {
        const userText = textFromPayload(turn.userTurn?.payload);
        const userPending = isPendingTurn(turn.userTurn?.payload);
        const agentText = agentMessageText(turn.agentEvents);
        const at = turn.agentEvents.at(-1)?.ts ?? turn.userTurn?.ts;
        return (
          <div
            key={turn.userTurn?.id ?? `pre-${i}`}
            className={`space-y-4 ${i > 0 ? 'mt-6 border-t border-hairline pt-6' : ''}`}
          >
            {turn.userTurn && (
              <div className="group grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
                <div className="flex justify-center pt-0.5">
                  <span aria-hidden className="grid size-7 place-items-center rounded-md bg-raised text-muted">
                    <Icon name="user" className="size-3.5" />
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="mb-1 flex items-center gap-2">
                    <span className={userRoleLabel}>You</span>
                    {turn.userTurn.ts && !userPending && (
                      <span className="font-data text-[11px] text-faint">{clockTime(turn.userTurn.ts)}</span>
                    )}
                    {userPending && (
                      <span role="status" className="inline-flex items-center gap-1 text-[11px] font-medium text-faint">
                        <span aria-hidden className="size-1.5 rounded-full bg-running-dot motion-safe:animate-dot-pulse" />
                        Sending…
                      </span>
                    )}
                    <CopyButton
                      text={userText}
                      label="Copy message"
                      className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    />
                  </div>
                  <p
                    className={`max-w-[68ch] whitespace-pre-wrap break-words rounded-lg bg-raised px-3.5 py-2.5 text-ink ${
                      userPending ? 'opacity-60' : ''
                    }`}
                  >
                    {userText}
                  </p>
                </div>
              </div>
            )}
            {turn.agentEvents.length > 0 && (
              <div className="group grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
                <div className="flex flex-col items-center">
                  <span
                    aria-hidden
                    className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-[11px] font-bold text-on-accent shadow-btn"
                  >
                    {agentLabel.charAt(0)}
                  </span>
                  <span aria-hidden className="mt-1.5 w-px flex-1 bg-edge" />
                </div>
                <div className="min-w-0 pb-1">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className={agentRoleLabel}>{agentLabel}</span>
                    {at && <span className="font-data text-[11px] text-faint">{clockTime(at)}</span>}
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
      )}
      {!following && (
        <div className="pointer-events-none sticky inset-x-0 bottom-3 z-10 flex justify-center">
          <button
            type="button"
            onClick={jumpToLatest}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface/95 px-3 py-1.5 text-[11.5px] font-semibold text-muted shadow-bar backdrop-blur-sm transition-colors hover:bg-raised hover:text-ink"
          >
            <Icon name="chevron-down" className="size-3" />
            Jump to latest
          </button>
        </div>
      )}
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

import { useMemo, type ReactNode } from 'react';
import { coalesceTail } from '../../event-stream-model';
import { transcriptLanes } from '../../transcript-timeline-model';
import { chatRows, type ChatRow, type ChatToolStatus } from '../../attempt-chat-model';
import type { AttemptLogEvent } from '../../types';
import { sectionTitle } from '../../ui';
import { FollowTail } from './FollowTail';

const TOOL_DOT: Record<ChatToolStatus, string> = {
  ok: 'bg-merged-dot',
  failed: 'bg-fail-dot',
  pending: 'bg-edge',
};

/** One tool call as a compact bordered card: a status dot, the verb, and the
 * target it touched — the three things the operator reads, no opaque call id. */
function ToolCard({ row }: { row: Extract<ChatRow, { kind: 'tool' }> }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-hairline bg-sunken px-3 py-2">
      <span aria-hidden className={`mt-[5px] size-2 shrink-0 rounded-full ${TOOL_DOT[row.status]}`} />
      <div className="min-w-0 flex-1">
        <span className="text-[12.5px] font-semibold text-ink">{row.verb}</span>
        {row.subagent && (
          <span className="ml-1.5 rounded-[4px] bg-raised px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.05em] text-muted">
            subagent
          </span>
        )}
        {row.target && <div className="mt-0.5 whitespace-pre-wrap break-words font-data text-[12px] text-accent">{row.target}</div>}
      </div>
    </div>
  );
}

/** The operator's own turn, folded into the stream where it landed — a tinted
 * right-aligned bubble tagged "You", set apart from the agent's plain messages
 * so a steer reads as a distinct human voice (no avatars — Paper register). */
function OperatorMessage({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end">
      <span className="mb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-faint">You</span>
      <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-raised px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink">
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    </div>
  );
}

function AssistantMessage({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink">{text}</p>;
}

function ThoughtMessage({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words border-l-2 border-hairline pl-3 text-[13px] italic leading-relaxed text-muted">
      {text}
    </p>
  );
}

function Note({ row }: { row: Extract<ChatRow, { kind: 'note' }> }) {
  return (
    <p className="text-center text-[11.5px] text-faint">
      <span className="font-semibold uppercase tracking-[0.06em]">{row.label}</span>
      {row.text && <span className="ml-1.5">{row.text}</span>}
    </p>
  );
}

function Row({ row }: { row: ChatRow }) {
  switch (row.kind) {
    case 'message':
      return row.author === 'operator' ? <OperatorMessage text={row.text} /> : <AssistantMessage text={row.text} />;
    case 'thought':
      return <ThoughtMessage text={row.text} />;
    case 'tool':
      return <ToolCard row={row} />;
    case 'note':
      return <Note row={row} />;
  }
}

/**
 * The Attempt's session as a chat (the Claude-Desktop register): the agent's
 * turns as plain assistant messages, the operator's steer turns as tinted "You"
 * bubbles folded in where they landed, and every tool call as a compact card.
 * A sticky header carries the follow/tail control that pins the panel to the
 * auto-updating live bottom; the steer input sits at the foot.
 */
export function ChatTranscript({
  events,
  unavailable,
  following,
  onToggleFollow,
  steer,
}: {
  events: AttemptLogEvent[];
  unavailable: boolean;
  following: boolean;
  onToggleFollow: () => void;
  steer?: ReactNode;
}) {
  const { rows, hidden } = useMemo(() => {
    // Chat the main agent's own turns; a spawned subagent surfaces as its
    // Agent/Task tool card in this lane, not as interleaved foreign messages.
    const main = transcriptLanes(events)[0];
    const { hidden, items } = coalesceTail(main?.events ?? []);
    return { rows: chatRows(items), hidden };
  }, [events]);

  return (
    <section className="pt-2">
      <div className="sticky top-0 z-10 -mx-[30px] mb-3 flex items-center justify-between gap-4 border-b border-hairline bg-canvas px-[30px] py-3">
        <div className="flex items-baseline gap-3">
          <h2 className={sectionTitle}>Transcript</h2>
          <p className="text-small text-faint">Session chat</p>
        </div>
        <FollowTail following={following} onToggle={onToggleFollow} />
      </div>
      {unavailable || rows.length === 0 ? (
        <p className="rounded-lg border border-hairline bg-surface px-4 py-6 text-center text-small text-muted shadow-card">
          No session transcript recorded for this run.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {hidden > 0 && (
            <p className="text-center text-[11.5px] text-faint">
              {hidden.toLocaleString()} earlier event{hidden === 1 ? '' : 's'} hidden — showing the live tail
            </p>
          )}
          {rows.map((row) => (
            <Row key={row.key} row={row} />
          ))}
        </div>
      )}
      {steer && <div className="mt-1">{steer}</div>}
    </section>
  );
}

import { useMemo, type ReactNode } from 'react';
import { coalesceEvents, coalesceTail } from '../../event-stream-model';
import { transcriptLanes } from '../../transcript-timeline-model';
import { chatRows, type ChatRow, type ChatToolStatus } from '../../attempt-chat-model';
import type { AttemptLogEvent } from '../../types';
import { railSectionCount } from '../../ui';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { FollowTail } from './FollowTail';

const CAPS = 'text-label font-bold uppercase tracking-[0.1em] text-faint';

const TOOL_DOT: Record<ChatToolStatus, string> = {
  ok: 'bg-merged-dot',
  failed: 'bg-fail-dot',
  pending: 'bg-edge',
};

const TOOL_BADGE: Record<Exclude<ChatToolStatus, 'pending'>, { label: string; tone: string }> = {
  ok: { label: 'passed', tone: 'text-merged' },
  failed: { label: 'failed', tone: 'text-fail' },
};

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function Avatar({ operator }: { operator: boolean }) {
  return operator ? (
    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-await-tint text-await">
      <Icon name="user" className="size-3.5" />
    </span>
  ) : (
    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent-tint text-[11px] font-bold text-accent">C</span>
  );
}

function MessageRow({ row, model }: { row: Extract<ChatRow, { kind: 'message' }>; model: string }) {
  const operator = row.author === 'operator';
  return (
    <div className="flex gap-3">
      <Avatar operator={operator} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-[12.5px] font-semibold text-ink">{operator ? 'You' : 'Claude'}</span>
          <span className="font-data text-[11px] text-faint">
            {operator ? 'steered' : model} · {clockTime(row.at)}
          </span>
        </div>
        {operator ? (
          <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink">{row.text}</p>
        ) : (
          <Markdown source={row.text} className="text-[13.5px] leading-relaxed text-ink" />
        )}
      </div>
    </div>
  );
}

function ToolCard({ row }: { row: Extract<ChatRow, { kind: 'tool' }> }) {
  const badge = row.status === 'pending' ? null : TOOL_BADGE[row.status];
  return (
    <div className="ml-10 overflow-hidden rounded-md border border-hairline bg-sunken">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${TOOL_DOT[row.status]}`} />
        <span className="shrink-0 text-[12.5px] font-semibold text-ink">{row.verb}</span>
        {row.subagent && (
          <span className="shrink-0 rounded-[4px] bg-raised px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.05em] text-muted">
            subagent
          </span>
        )}
        {row.target && <span className="min-w-0 flex-1 truncate font-data text-[12px] text-accent">{row.target}</span>}
        {badge && (
          <span className={`ml-auto shrink-0 text-[10px] font-bold uppercase tracking-[0.05em] ${badge.tone}`}>{badge.label}</span>
        )}
      </div>
      {row.output && (
        <pre className="max-h-60 overflow-auto border-t border-hairline px-3 py-2 font-data text-[11.5px] leading-[1.55] text-muted">
          {row.output}
        </pre>
      )}
    </div>
  );
}

function ThoughtMessage({ text }: { text: string }) {
  return (
    <p className="ml-10 whitespace-pre-wrap break-words border-l-2 border-hairline pl-3 text-[13px] italic leading-relaxed text-muted">
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

/** A spawned Subagent's own transcript, folded under the Agent call that
 * spawned it — collapsed by default so the main agent's thread stays legible,
 * one click away when the operator wants the detail. */
function SubagentLane({ label, rows, model }: { label: string; rows: ChatRow[]; model: string }) {
  return (
    <details className="ml-10 overflow-hidden rounded-md border border-hairline bg-surface">
      <summary className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-[12.5px] font-semibold text-ink hover:bg-raised">
        <span className="rounded-[4px] bg-raised px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.05em] text-muted">subagent</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className={railSectionCount}>{rows.length}</span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-hairline px-3 py-3">
        {rows.map((row) => (
          <Row key={row.key} row={row} model={model} />
        ))}
      </div>
    </details>
  );
}

function Row({ row, model }: { row: ChatRow; model: string }) {
  switch (row.kind) {
    case 'message':
      return <MessageRow row={row} model={model} />;
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
 * turns as assistant messages with an author · model · time header, the
 * operator's steer turns folded in where they were sent, its private reasoning
 * as quiet thought blocks, and every tool call as a compact card with its
 * output. A sticky header carries the step name, the event count, and the
 * follow/tail control; the steer input sits at the foot.
 */
export function ChatTranscript({
  events,
  unavailable,
  following,
  onToggleFollow,
  steer,
  model,
  stepLabel,
}: {
  events: AttemptLogEvent[];
  unavailable: boolean;
  following?: boolean;
  onToggleFollow?: () => void;
  steer?: ReactNode;
  model: string;
  stepLabel?: string;
}) {
  const { rows, hidden, lanes } = useMemo(() => {
    // Chat the main agent's own turns; each spawned Subagent's turns lane under
    // the Agent/Task card that spawned it, never interleaved as foreign messages.
    const [main, ...subagents] = transcriptLanes(events);
    const { hidden, items } = coalesceTail(main?.events ?? []);
    const lanes = new Map(subagents.map((lane) => [lane.id, { label: lane.label, rows: chatRows(coalesceEvents(lane.events)) }]));
    return { rows: chatRows(items), hidden, lanes };
  }, [events]);
  // A lane whose spawning card fell outside the rendered tail still shows, at the end.
  const anchored = new Set(rows.flatMap((row) => (row.kind === 'tool' && row.toolCallId && lanes.has(row.toolCallId) ? [row.toolCallId] : [])));

  return (
    <section className="pt-2">
      <div className="sticky top-0 z-10 -mx-[30px] mb-3 flex items-center justify-between gap-4 border-b border-hairline bg-canvas px-[30px] py-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className={CAPS}>Transcript{stepLabel && ` · ${stepLabel}`}</h2>
          <span className={railSectionCount}>{events.length} events</span>
        </div>
        {onToggleFollow && <FollowTail following={following ?? false} onToggle={onToggleFollow} />}
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
          {rows.map((row) => {
            const lane = row.kind === 'tool' && row.toolCallId ? lanes.get(row.toolCallId) : undefined;
            return (
              <div key={row.key} className="flex flex-col gap-3">
                <Row row={row} model={model} />
                {lane && <SubagentLane label={lane.label} rows={lane.rows} model={model} />}
              </div>
            );
          })}
          {[...lanes].filter(([id]) => !anchored.has(id)).map(([id, lane]) => (
            <SubagentLane key={id} label={lane.label} rows={lane.rows} model={model} />
          ))}
        </div>
      )}
      {steer && <div className="mt-1">{steer}</div>}
    </section>
  );
}

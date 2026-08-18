import type { ReactNode } from 'react';
import { coalesceEvents, isInterrupted, type StreamEvent, type ToolCallView } from '../event-stream-model';
import { chip, labelType, toolChip } from '../ui';

// ACP tool kinds → the short word on the chip. Anything unknown or absent
// reads as a generic "tool" — the opaque toolCallId is never a label.
const TOOL_KIND_LABEL: Record<string, string> = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'run',
  think: 'think',
  fetch: 'fetch',
  other: 'tool',
};

function toolKindLabel(kind: string | undefined): string {
  return (kind && TOOL_KIND_LABEL[kind]) ?? 'tool';
}

/** The one thing the operator asked to see — is it finished? — kept quiet:
 * a running tool pulses, a finished one recedes to a check, a failed one is
 * the only status worth a color (redundant with its aria-label). */
function ToolStatus({ status }: { status: string | undefined }) {
  if (status === 'completed')
    return (
      <span aria-label="completed" className="shrink-0 text-muted">
        ✓
      </span>
    );
  if (status === 'failed')
    return (
      <span aria-label="failed" className="shrink-0 text-fail">
        ✕
      </span>
    );
  return (
    <span aria-label="running" className="shrink-0 text-faint motion-safe:animate-pulse">
      •
    </span>
  );
}

/** One tool call as a single scannable line: kind chip · what it touched ·
 * done? The target is machine data (a path, a command) so it stays mono and
 * truncates to one line — never the multi-line wrap that let the status chip
 * drift mid-title and clip at the panel edge. */
function ToolLine({ tool }: { tool: ToolCallView }) {
  const target = tool.title || 'Tool call';
  return (
    <div className="flex items-center gap-2">
      <span className={`${toolChip} shrink-0`}>{toolKindLabel(tool.toolKind)}</span>
      <span className="min-w-0 flex-1 truncate font-data text-data text-ink" title={target}>
        {target}
      </span>
      {tool.subagent && <span className={`${chip} shrink-0 bg-raised text-muted`}>subagent</span>}
      <ToolStatus status={tool.status} />
    </div>
  );
}

/**
 * The transcript shows the *conversation*, not the protocol. Agent prose,
 * thoughts and tool calls (folded upstream) are the content; a plan and a
 * genuine model-mismatch warning also earn a line. Everything else the harness
 * streams — usage ticks, "tools loaded" / mode-change chatter, resolved-
 * permission echoes, and turn-started/ended bookkeeping — is noise the operator
 * doesn't read, so it returns null and never renders (the caller drops nulls,
 * so no empty rows are left behind). Only non-text, non-tool events reach here.
 */
function renderEventLine(event: StreamEvent): ReactNode {
  if (event.type === 'session_update') {
    if (event.payload.sessionUpdate === 'plan') {
      return (
        <ul className="space-y-0.5">
          {(event.payload.entries ?? []).map((entry: any, i: number) => (
            <li key={i} className="flex items-start gap-2 text-ink">
              <span className="shrink-0 text-muted">
                {entry.status === 'completed' ? '☑' : entry.status === 'in_progress' ? '◐' : '☐'}
              </span>
              {/* Plan entries are the agent's own prose — Body sans, not the
                  code face (the Mono Is Code Rule). */}
              <span>{entry.content}</span>
            </li>
          ))}
        </ul>
      );
    }
    // usage ticks, capability/mode chatter ("tools loaded") — all bookkeeping.
    return null;
  }
  // A resolved permission is already implied by the tool row that ran after it
  // (and was surfaced live as its own prompt) — no echo line in the transcript.
  if (event.type === 'permission_request') return null;
  if (event.type === 'lifecycle' && isInterrupted(event.payload)) {
    // The one lifecycle line worth keeping: it confirms the operator's own
    // Stop/Interrupt landed. A normal turn end is silent.
    return <div className="text-muted">Interrupted</div>;
  }
  if (event.payload.event === 'model_mismatch') {
    // The model setting shown must be real — the harness ran something other
    // than the task's pin. Harness metadata, not a failure: Tooling cyan, never
    // Failed rose (the run completed). A model name reads as language, so it's
    // sans at UI-emphasis weight — mono is for code (the Mono Is Code Rule).
    return (
      <div className="text-tool">
        model mismatch: ran on <span className="font-medium">{(event.payload.observed ?? []).join(', ')}</span> (task
        pinned <span className="font-medium">{event.payload.expected}</span>)
      </div>
    );
  }
  if (event.payload.event === 'steer_delivered' || event.payload.event === 'steer_queued') {
    // The operator steered this run. Keep it in the transcript so the redirect
    // is visible next to the turn it lands on — queued shows it was accepted,
    // delivered shows the turn it opened. Rendered as an operator aside, not
    // agent prose: accent-tinted, labelled, the steering text quoted verbatim.
    const queued = event.payload.event === 'steer_queued';
    return (
      <div className="rounded-md bg-accent-tint px-2 py-1 text-ink">
        <span className={`${labelType} mr-2 text-accent`}>{queued ? 'steer queued' : 'steering'}</span>
        <span className="whitespace-pre-wrap">{String(event.payload.text ?? '')}</span>
      </div>
    );
  }
  if (event.payload.event === 'progress-nudge') {
    // The stall detector redirected the agent one turn before it would have
    // tripped the Progress guardrail (issue #171). An operator aside like
    // steer_delivered/steer_queued above — accent-tinted, labelled — but this
    // one is the system's own nudge, not something the operator typed.
    return (
      <div className="rounded-md bg-accent-tint px-2 py-1 text-ink">
        <span className={`${labelType} mr-2 text-accent`}>progress nudge</span>
        <span>
          Redirected before a guardrail trip
          {event.payload.pattern ? ` — ${String(event.payload.pattern)}` : ''}
        </span>
      </div>
    );
  }
  if (event.payload.event === 'guardrail-tripped') {
    // A Guardrail actually tripped and settled the run (issue #171) — Failed
    // rose like model_mismatch's Tooling cyan is to harness metadata, naming
    // the dimension and the reason the trip already formatted server-side.
    return (
      <div className="text-fail">
        guardrail tripped: <span className="font-medium">{String(event.payload.dimension)}</span>
        {event.payload.reason ? ` — ${String(event.payload.reason)}` : ''}
      </div>
    );
  }
  // Every other lifecycle/protocol event (turn started, finished, …) is noise.
  return null;
}

export function EventStream<E extends StreamEvent>({ events }: { events: E[] }) {
  // The stream carries two different textures: the agent's prose (message /
  // thought) reads in the Body sans face like any other copy, while machine
  // output — tool targets, model names, ids — answers in the Data face.
  // Keeping them distinct is what stops a turn reading as one flat mono wall.
  const items = coalesceEvents(events);
  const rendered = items.map((item) => {
    if (item.kind === 'text') {
      return (
        <p
          key={item.key}
          className={
            item.variant === 'thought'
              ? 'whitespace-pre-wrap italic text-muted'
              : 'whitespace-pre-wrap text-ink'
          }
        >
          {item.text}
        </p>
      );
    }
    if (item.kind === 'tool') return <ToolLine key={item.key} tool={item.tool} />;
    // Protocol/lifecycle noise renders nothing and leaves no gap behind.
    const line = renderEventLine(item.event);
    return line ? <div key={item.key}>{line}</div> : null;
  });
  return (
    <div className="space-y-2">
      {rendered}
      {events.length === 0 && <p className="text-muted">No events.</p>}
    </div>
  );
}

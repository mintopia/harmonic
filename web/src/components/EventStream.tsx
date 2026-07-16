import { coalesceEvents, type StreamEvent, type ToolCallView } from '../event-stream-model';
import { chip, toolChip } from '../ui';

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

function EventLine({ event }: { event: StreamEvent }) {
  if (event.type === 'session_update') {
    // Only non-text, non-tool session updates reach here (chunks and tool
    // calls are folded upstream in coalesceEvents).
    if (event.payload.sessionUpdate === 'plan') {
      return (
        <ul className="space-y-0.5">
          {(event.payload.entries ?? []).map((entry: any, i: number) => (
            <li key={i} className="flex items-start gap-2 text-ink">
              <span className="shrink-0 text-muted">
                {entry.status === 'completed' ? '☑' : entry.status === 'in_progress' ? '◐' : '☐'}
              </span>
              {/* Plan entries are the agent's own prose — Body sans, not the
                  Data face (the Mono Is Data Rule). */}
              <span>{entry.content}</span>
            </li>
          ))}
        </ul>
      );
    }
    if (event.payload.sessionUpdate === 'usage_update') return null; // context-window fill; not a stream line
    return <span className="text-muted">{event.payload.sessionUpdate}</span>;
  }
  if (event.type === 'permission_request') {
    return (
      <div className="flex items-center gap-2">
        <span className={`${toolChip} shrink-0`}>permission</span>
        <span className="min-w-0 flex-1 truncate text-ink">
          {event.payload.request?.toolCall?.title ?? 'request'}
        </span>
        <span className="shrink-0 text-muted">→ {event.payload.outcome?.outcome ?? '?'}</span>
      </div>
    );
  }
  if (
    event.type === 'lifecycle' &&
    event.payload.event === 'finished' &&
    event.payload.stopReason === 'cancelled'
  ) {
    // Honest, not "finished (cancelled)" (issue #14): the operator
    // interrupted this Turn, it didn't wrap up on its own — the steering
    // message that follows opens a new Turn, not a continuation.
    return <div className="text-muted">cancelled</div>;
  }
  if (event.payload.event === 'model_mismatch') {
    // Q7: the model setting shown must be real — the harness ran something
    // other than the task's pin. Harness metadata, not a failure: Tool Teal,
    // never Fail Red (the run completed). Model names are data → mono.
    return (
      <div className="text-tool">
        model mismatch: ran on{' '}
        <span className="font-data text-data">{(event.payload.observed ?? []).join(', ')}</span> (task
        pinned <span className="font-data text-data">{event.payload.expected}</span>)
      </div>
    );
  }
  return (
    <div className="text-muted">
      {event.payload.event} {event.payload.stopReason ? `(${event.payload.stopReason})` : ''}
    </div>
  );
}

export function EventStream<E extends StreamEvent>({ events }: { events: E[] }) {
  // The stream carries two different textures: the agent's prose (message /
  // thought) reads in the Body sans face like any other copy, while machine
  // output — tool targets, model names, ids — answers in the Data face.
  // Keeping them distinct is what stops a turn reading as one flat mono wall.
  const items = coalesceEvents(events);
  return (
    <div className="space-y-2">
      {items.map((item) =>
        item.kind === 'text' ? (
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
        ) : item.kind === 'tool' ? (
          <ToolLine key={item.key} tool={item.tool} />
        ) : (
          <div key={item.key}>
            <EventLine event={item.event} />
          </div>
        ),
      )}
      {events.length === 0 && <p className="text-muted">No events.</p>}
    </div>
  );
}

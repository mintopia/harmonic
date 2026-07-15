import { coalesceEvents, type StreamEvent } from '../event-stream-model';
import { chip, toolChip } from '../ui';

function ToolCallLine({ payload }: { payload: any }) {
  return (
    <div className="flex items-center gap-2">
      <span className={toolChip}>{payload.kind ?? 'tool'}</span>
      <span className="text-ink">{payload.title ?? payload.toolCallId}</span>
      {payload._meta?.claudeCode?.parentToolUseId && (
        <span className={`${chip} bg-raised text-muted`}>subagent</span>
      )}
      <span className="text-muted">{payload.status}</span>
    </div>
  );
}

function SessionUpdate({ payload }: { payload: any }) {
  switch (payload.sessionUpdate) {
    // agent_message_chunk / agent_thought_chunk are coalesced into flowing
    // text blocks upstream (event-stream-model) and never reach here.
    case 'tool_call':
    case 'tool_call_update':
      return <ToolCallLine payload={payload} />;
    case 'plan':
      return (
        <ul className="space-y-0.5">
          {(payload.entries ?? []).map((entry: any, i: number) => (
            <li key={i} className="flex items-center gap-2 text-ink">
              <span>{entry.status === 'completed' ? '☑' : entry.status === 'in_progress' ? '◐' : '☐'}</span>
              {entry.content}
            </li>
          ))}
        </ul>
      );
    case 'usage_update':
      return null; // context-window fill; not worth a stream line
    default:
      return <span className="text-muted">{payload.sessionUpdate}</span>;
  }
}

function EventLine({ event }: { event: StreamEvent }) {
  if (event.type === 'session_update') {
    return <SessionUpdate payload={event.payload} />;
  }
  if (event.type === 'permission_request') {
    return (
      <div className="flex items-center gap-2">
        <span className={toolChip}>permission</span>
        <span className="text-ink">{event.payload.request?.toolCall?.title ?? 'request'}</span>
        <span className="text-muted">→ {event.payload.outcome?.outcome ?? '?'}</span>
      </div>
    );
  }
  if (event.type === 'lifecycle' && event.payload.event === 'finished' && event.payload.stopReason === 'cancelled') {
    // Honest, not "finished (cancelled)" (issue #14): the operator
    // interrupted this Turn, it didn't wrap up on its own — the steering
    // message that follows opens a new Turn, not a continuation.
    return <div className="text-muted">cancelled</div>;
  }
  if (event.payload.event === 'model_mismatch') {
    // Q7: the model setting shown must be real — the harness ran
    // something other than the task's pin. Harness metadata, not a
    // failure: Tool Indigo, never Fail Red (the run completed).
    return (
      <div className="text-tool">
        model mismatch: ran on {(event.payload.observed ?? []).join(', ')} (task pinned{' '}
        {event.payload.expected})
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
  // The stream is machine output — the one prose-adjacent surface that
  // stays in the Data face. Consecutive chunks read as one utterance, so
  // they are coalesced into flowing text before rendering.
  const items = coalesceEvents(events);
  return (
    <div className="space-y-1 font-data text-data">
      {items.map((item) =>
        item.kind === 'text' ? (
          <div key={item.key}>
            <span
              className={
                item.variant === 'thought'
                  ? 'whitespace-pre-wrap italic text-muted'
                  : 'whitespace-pre-wrap text-ink'
              }
            >
              {item.text}
            </span>
          </div>
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

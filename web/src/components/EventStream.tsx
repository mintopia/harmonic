import type { RunEvent } from '../types';
import { chip } from '../ui';

/* Tool calls and permission traffic are harness/tooling metadata — Tool
 * Indigo territory (the State Speaks Rule). */
const toolChip = `${chip} bg-tool/15 text-tool`;

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
    case 'agent_message_chunk':
      return <span className="whitespace-pre-wrap text-ink">{payload.content?.text ?? ''}</span>;
    case 'agent_thought_chunk':
      return <span className="whitespace-pre-wrap italic text-muted">{payload.content?.text ?? ''}</span>;
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

export function EventStream({ events }: { events: RunEvent[] }) {
  // The stream is machine output — the one prose-adjacent surface that
  // stays in the Data face. Consecutive chunks read as one utterance.
  return (
    <div className="space-y-1 font-data text-data">
      {events.map((event) => {
        if (event.type === 'session_update') {
          const rendered = <SessionUpdate payload={event.payload} />;
          if (rendered === null) return null;
          return <div key={event.id}>{rendered}</div>;
        }
        if (event.type === 'permission_request') {
          return (
            <div key={event.id} className="flex items-center gap-2">
              <span className={toolChip}>permission</span>
              <span className="text-ink">{event.payload.request?.toolCall?.title ?? 'request'}</span>
              <span className="text-muted">→ {event.payload.outcome?.outcome ?? '?'}</span>
            </div>
          );
        }
        if (event.payload.event === 'model_mismatch') {
          // Q7: the model setting shown must be real — the harness ran
          // something other than the task's pin. Harness metadata, not a
          // failure: Tool Indigo, never Fail Red (the run completed).
          return (
            <div key={event.id} className="text-tool">
              model mismatch: ran on {(event.payload.observed ?? []).join(', ')} (task pinned{' '}
              {event.payload.expected})
            </div>
          );
        }
        return (
          <div key={event.id} className="text-muted">
            {event.payload.event} {event.payload.stopReason ? `(${event.payload.stopReason})` : ''}
          </div>
        );
      })}
      {events.length === 0 && <p className="text-muted">No events.</p>}
    </div>
  );
}

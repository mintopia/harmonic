import type { RunEvent } from '../types';

function ToolCallLine({ payload }: { payload: any }) {
  return (
    <div className="flex items-center gap-2">
      <span className="rounded bg-indigo-900/70 px-1.5 py-0.5 text-[11px] text-indigo-300">
        {payload.kind ?? 'tool'}
      </span>
      <span className="text-zinc-200">{payload.title ?? payload.toolCallId}</span>
      {payload._meta?.claudeCode?.parentToolUseId && (
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-500">subagent</span>
      )}
      <span className="text-[11px] text-zinc-500">{payload.status}</span>
    </div>
  );
}

function SessionUpdate({ payload }: { payload: any }) {
  switch (payload.sessionUpdate) {
    case 'agent_message_chunk':
      return <span className="whitespace-pre-wrap text-zinc-200">{payload.content?.text ?? ''}</span>;
    case 'agent_thought_chunk':
      return <span className="whitespace-pre-wrap italic text-zinc-500">{payload.content?.text ?? ''}</span>;
    case 'tool_call':
    case 'tool_call_update':
      return <ToolCallLine payload={payload} />;
    case 'plan':
      return (
        <ul className="space-y-0.5">
          {(payload.entries ?? []).map((entry: any, i: number) => (
            <li key={i} className="flex items-center gap-2 text-zinc-300">
              <span>{entry.status === 'completed' ? '☑' : entry.status === 'in_progress' ? '◐' : '☐'}</span>
              {entry.content}
            </li>
          ))}
        </ul>
      );
    case 'usage_update':
      return null; // context-window fill; not worth a stream line
    default:
      return <span className="text-[11px] text-zinc-600">{payload.sessionUpdate}</span>;
  }
}

export function EventStream({ events }: { events: RunEvent[] }) {
  // Consecutive message/thought chunks read as one utterance.
  return (
    <div className="space-y-1 font-mono text-xs leading-relaxed">
      {events.map((event) => {
        if (event.type === 'session_update') {
          const rendered = <SessionUpdate payload={event.payload} />;
          if (rendered === null) return null;
          return <div key={event.id}>{rendered}</div>;
        }
        if (event.type === 'permission_request') {
          return (
            <div key={event.id} className="flex items-center gap-2">
              <span className="rounded bg-amber-900/70 px-1.5 py-0.5 text-[11px] text-amber-300">permission</span>
              <span className="text-zinc-300">{event.payload.request?.toolCall?.title ?? 'request'}</span>
              <span className="text-[11px] text-zinc-500">→ {event.payload.outcome?.outcome ?? '?'}</span>
            </div>
          );
        }
        return (
          <div key={event.id} className="text-[11px] text-zinc-600">
            {event.payload.event} {event.payload.stopReason ? `(${event.payload.stopReason})` : ''}
          </div>
        );
      })}
      {events.length === 0 && <p className="text-zinc-600">No events.</p>}
    </div>
  );
}

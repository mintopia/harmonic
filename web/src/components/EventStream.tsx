import { useMemo, type ReactNode } from 'react';
import { coalesceTail, isInterrupted, movingBaseView, type StreamEvent, type ToolCallView } from '../event-stream-model';
import { guardrailDimensionLabel } from '../guardrail-trip-model';
import { chip, labelType, toolChip } from '../ui';

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
              <span>{entry.content}</span>
            </li>
          ))}
        </ul>
      );
    }
    return null;
  }
  if (event.type === 'permission_request') return null;
  if (event.type === 'lifecycle' && isInterrupted(event.payload)) {
    return <div className="text-muted">Interrupted</div>;
  }
  if (event.payload.event === 'model_mismatch') {
    return (
      <div className="text-tool">
        model mismatch: ran on <span className="font-medium">{(event.payload.observed ?? []).join(', ')}</span> (task
        pinned <span className="font-medium">{event.payload.expected}</span>)
      </div>
    );
  }
  if (event.payload.event === 'steer_delivered' || event.payload.event === 'steer_queued') {
    const queued = event.payload.event === 'steer_queued';
    return (
      <div className="rounded-md bg-accent-tint px-2 py-1 text-ink">
        <span className={`${labelType} mr-2 text-accent`}>{queued ? 'steer queued' : 'steering'}</span>
        <span className="whitespace-pre-wrap">{String(event.payload.text ?? '')}</span>
      </div>
    );
  }
  if (event.payload.event === 'progress-nudge') {
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
  const movingBase = movingBaseView(event.payload);
  if (movingBase) {
    return (
      <div className={movingBase.nearBound ? 'text-muted' : 'text-faint'}>
        {movingBase.label}
        {movingBase.count && <span className="ml-1 tabular-nums">{movingBase.count}</span>}
      </div>
    );
  }
  if (event.payload.event === 'guardrail-tripped') {
    return (
      <div className="text-fail">
        Guardrail tripped —{' '}
        <span className="font-medium">{guardrailDimensionLabel(String(event.payload.dimension))}</span>
        {event.payload.reason ? `: ${String(event.payload.reason)}` : ''}
      </div>
    );
  }
  return null;
}

export function EventStream<E extends StreamEvent>({ events }: { events: E[] }) {
  // Coalescing is O(n) over its input, so recomputing it on every render — a
  // parent re-renders on each task_changed, not just on a new event — is the
  // O(n²) the operator feels as the panel stiffening late in a long turn.
  // Memoizing on the `events` array (a fresh reference only when one is
  // appended) plus capping the input to a bounded tail keeps it flat.
  const { items, hidden } = useMemo(() => coalesceTail(events), [events]);
  // The rendered nodes are memoized on `items`, so an unrelated parent
  // re-render reuses them and React skips the whole transcript subtree.
  const rendered = useMemo(
    () =>
      items.map((item) => {
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
        const line = renderEventLine(item.event);
        return line ? <div key={item.key}>{line}</div> : null;
      }),
    [items],
  );
  return (
    <div className="space-y-2">
      {hidden > 0 && (
        <p className="text-muted">
          <span className="tabular-nums">{hidden.toLocaleString()}</span> earlier{' '}
          {hidden === 1 ? 'event' : 'events'} hidden
        </p>
      )}
      {rendered}
      {events.length === 0 && <p className="text-muted">No events.</p>}
    </div>
  );
}

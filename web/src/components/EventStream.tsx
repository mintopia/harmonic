import { useMemo, type ReactNode } from 'react';
import { coalesceTail, isInterrupted, movingBaseView, type StreamEvent, type ToolCallView } from '../event-stream-model';
import { guardrailDimensionLabel } from '../guardrail-trip-model';
import { chip, labelType, toolChip } from '../ui';
import { Markdown } from './Markdown';

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
    <details className="group rounded-md border border-hairline bg-sunken px-2 py-1.5">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <span className={`${toolChip} shrink-0`}>{toolKindLabel(tool.toolKind)}</span>
        <span className="min-w-0 flex-1 truncate font-data text-data text-ink" title={target}>
          {target}
        </span>
        {tool.subagent && <span className={`${chip} shrink-0 bg-raised text-muted`}>subagent</span>}
        <ToolStatus status={tool.status} />
      </summary>
      <div className="mt-2 border-t border-hairline pt-2">
        <p className="break-all font-data text-data text-ink">{target}</p>
        {tool.input && (
          <pre className="mt-2 max-h-80 overflow-auto rounded-sm bg-field p-2 font-data text-data text-ink">{tool.input}</pre>
        )}
        {tool.output && (
          <pre className="mt-2 max-h-80 overflow-auto rounded-sm bg-field p-2 font-data text-data text-ink">{tool.output}</pre>
        )}
      </div>
    </details>
  );
}

function renderEventLine(event: StreamEvent): ReactNode {
  const payload = event.payload as
    | {
        sessionUpdate?: string;
        entries?: { status?: string; content?: string }[];
        event?: string;
        observed?: unknown[];
        expected?: unknown;
        text?: unknown;
        pattern?: unknown;
        dimension?: unknown;
        reason?: unknown;
      }
    | null
    | undefined;
  if (event.type === 'session_update') {
    if (payload?.sessionUpdate === 'plan') {
      return (
        <ul className="space-y-0.5">
          {(payload.entries ?? []).map((entry, i) => (
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
  if (payload?.event === 'model_mismatch') {
    return (
      <div className="text-tool">
        model mismatch: ran on{' '}
        <span className="font-medium">{(payload.observed ?? []).join(', ')}</span> (task pinned{' '}
        <span className="font-medium">{String(payload.expected)}</span>)
      </div>
    );
  }
  if (payload?.event === 'steer_delivered' || payload?.event === 'steer_queued') {
    const queued = payload.event === 'steer_queued';
    return (
      <div className="rounded-md bg-accent-tint px-2 py-1 text-ink">
        <span className={`${labelType} mr-2 text-accent`}>{queued ? 'steer queued' : 'steering'}</span>
        <span className="whitespace-pre-wrap">{String(payload.text ?? '')}</span>
      </div>
    );
  }
  if (payload?.event === 'progress-nudge') {
    return (
      <div className="rounded-md bg-accent-tint px-2 py-1 text-ink">
        <span className={`${labelType} mr-2 text-accent`}>progress nudge</span>
        <span>
          Redirected before a guardrail trip
          {payload.pattern ? ` — ${String(payload.pattern)}` : ''}
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
  if (payload?.event === 'guardrail-tripped') {
    return (
      <div className="text-fail">
        Guardrail tripped —{' '}
        <span className="font-medium">{guardrailDimensionLabel(String(payload.dimension))}</span>
        {payload.reason ? `: ${String(payload.reason)}` : ''}
      </div>
    );
  }
  return null;
}

export function EventStream<E extends StreamEvent>({ events }: { events: E[] }) {
  const { items, hidden } = useMemo(() => coalesceTail(events), [events]);
  const rendered = useMemo(
    () =>
      items.map((item) => {
        if (item.kind === 'text') {
          return (
            <Markdown
              key={item.key}
              source={item.text}
              className={item.variant === 'thought' ? 'italic text-muted' : 'text-ink'}
            />
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

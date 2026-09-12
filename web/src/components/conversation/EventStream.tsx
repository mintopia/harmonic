import { useMemo, type ReactNode } from 'react';
import { coalesceTail, isInterrupted, movingBaseView, type StreamEvent, type ToolCallView } from '../../event-stream-model';
import { guardrailDimensionLabel } from '../../guardrail-trip-model';
import { chip, labelType, toolChip } from '../../ui';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { DiffViewer } from '../DiffViewer';
import { toolDiffFile } from '../../tool-diff';

const READ_MEASURE = 'max-w-[68ch]';
const OUTPUT_WELL = 'mt-1 max-h-56 overflow-auto rounded-md bg-surface px-3 py-2 font-data text-data text-muted';
const TOOL_ROW = 'flex items-center gap-2 py-1';
const TOOL_TARGET = 'min-w-0 flex-1 truncate font-data text-data';
const DISCLOSURE = 'size-3 shrink-0 text-faint transition-transform duration-150 group-open:rotate-180';

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
      <span aria-label="completed" className="shrink-0 text-merged">
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
    <span aria-label="running" className="shrink-0 text-running motion-safe:animate-pulse">
      •
    </span>
  );
}

function inputValue(input: string | null, keys: readonly string[]): string | null {
  if (!input) return null;
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    for (const [key, value] of Object.entries(parsed)) {
      if (!keys.includes(key) || (typeof value !== 'string' && typeof value !== 'number')) continue;
      return String(value);
    }
  } catch {
    return null;
  }
  return null;
}

function ExecuteCard({ tool }: { tool: ToolCallView }) {
  const command = inputValue(tool.input, ['command', 'cmd']) ?? tool.title ?? 'Command';
  return (
    <div>
      <div className={TOOL_ROW}>
        <span className={`${toolChip} shrink-0`}>run</span>
        <span className={`${TOOL_TARGET} text-ink`} title={command}>{command}</span>
        <ToolStatus status={tool.status} />
      </div>
      {tool.output && <pre className={OUTPUT_WELL}>{tool.output}</pre>}
    </div>
  );
}

function ReadCard({ tool }: { tool: ToolCallView }) {
  const path = inputValue(tool.input, ['path', 'filePath', 'file_path']) ?? tool.title ?? 'File';
  const start = inputValue(tool.input, ['lineStart', 'startLine', 'start']);
  const end = inputValue(tool.input, ['lineEnd', 'endLine', 'end']);
  const range = start && end ? `lines ${start}–${end}` : start ? `line ${start}` : null;
  const head = (
    <>
      <span className={`${toolChip} shrink-0`}>read</span>
      <span className={`${TOOL_TARGET} text-muted`} title={path}>{path}</span>
      {range && <span className="shrink-0 font-data text-[11px] text-faint">{range}</span>}
      <ToolStatus status={tool.status} />
    </>
  );
  if (!tool.output) return <div className={TOOL_ROW}>{head}</div>;
  return (
    <details className="group">
      <summary className={`${TOOL_ROW} cursor-pointer list-none`}>
        {head}
        <Icon name="chevron-down" className={DISCLOSURE} />
      </summary>
      <pre className={OUTPUT_WELL}>{tool.output}</pre>
    </details>
  );
}

function EditCard({ tool }: { tool: ToolCallView }) {
  if (!tool.diffs?.length) return <GenericToolCard tool={tool} />;
  const files = tool.diffs.map(toolDiffFile);
  const single = files.length === 1 ? files[0] : null;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div className="overflow-hidden rounded-md bg-surface shadow-card">
      <div className="flex items-center gap-2 border-b border-hairline bg-sunken px-3 py-1.5">
        <span className={`${toolChip} shrink-0`}>edit</span>
        <span className="min-w-0 flex-1 truncate font-data text-data text-ink" title={single?.path ?? tool.title}>
          {single ? single.path : `${files.length} files`}
        </span>
        <span className="shrink-0 font-data text-small tabular-nums text-merged">+{additions}</span>
        <span className="shrink-0 font-data text-small tabular-nums text-fail">−{deletions}</span>
        <ToolStatus status={tool.status} />
      </div>
      {files.map((file, index) => (
        <DiffViewer key={`${file.path}-${index}`} file={file} headerless={files.length === 1} />
      ))}
    </div>
  );
}

function GenericToolCard({ tool }: { tool: ToolCallView }) {
  const target = tool.title || 'Tool call';
  const head = (
    <>
      <span className={`${toolChip} shrink-0`}>{toolKindLabel(tool.toolKind)}</span>
      <span className={`${TOOL_TARGET} text-muted`} title={target}>{target}</span>
      {tool.subagent && <span className={`${chip} shrink-0 bg-raised text-muted`}>subagent</span>}
      <ToolStatus status={tool.status} />
    </>
  );
  if (!tool.input && !tool.output) return <div className={TOOL_ROW}>{head}</div>;
  return (
    <details className="group">
      <summary className={`${TOOL_ROW} cursor-pointer list-none`}>
        {head}
        <Icon name="chevron-down" className={DISCLOSURE} />
      </summary>
      {tool.input && <pre className={OUTPUT_WELL}>{tool.input}</pre>}
      {tool.output && <pre className={OUTPUT_WELL}>{tool.output}</pre>}
    </details>
  );
}

function ToolLine({ tool }: { tool: ToolCallView }) {
  if (tool.diffs?.length || tool.toolKind === 'edit') return <EditCard tool={tool} />;
  if (tool.toolKind === 'execute') return <ExecuteCard tool={tool} />;
  if (tool.toolKind === 'read') return <ReadCard tool={tool} />;
  return <GenericToolCard tool={tool} />;
}

function payloadValue(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return Object.entries(payload).find(([name]) => name === key)?.[1];
}

function planGlyph(status: unknown): { mark: string; tone: string; text: string } {
  if (status === 'completed') return { mark: '☑', tone: 'text-merged', text: 'text-muted' };
  if (status === 'in_progress') return { mark: '◐', tone: 'text-running', text: 'text-ink' };
  return { mark: '☐', tone: 'text-faint', text: 'text-ink' };
}

function renderEventLine(event: StreamEvent): ReactNode {
  const sessionUpdate = payloadValue(event.payload, 'sessionUpdate');
  const entries = payloadValue(event.payload, 'entries');
  const eventName = payloadValue(event.payload, 'event');
  const observed = payloadValue(event.payload, 'observed');
  const expected = payloadValue(event.payload, 'expected');
  const text = payloadValue(event.payload, 'text');
  const pattern = payloadValue(event.payload, 'pattern');
  const dimension = payloadValue(event.payload, 'dimension');
  const reason = payloadValue(event.payload, 'reason');
  if (event.type === 'session_update') {
    if (sessionUpdate === 'plan') {
      return (
        <div className="rounded-md bg-surface px-3 py-2.5 shadow-card">
          <div className={`${labelType} mb-2 text-[10px] tracking-[0.09em] text-faint`}>Plan</div>
          <ul className="space-y-1">
            {(Array.isArray(entries) ? entries : []).map((entry, i) => {
              const glyph = planGlyph(payloadValue(entry, 'status'));
              return (
                <li key={i} className="flex items-start gap-2">
                  <span aria-hidden className={`shrink-0 ${glyph.tone}`}>{glyph.mark}</span>
                  <span className={glyph.text}>{String(payloadValue(entry, 'content') ?? '')}</span>
                </li>
              );
            })}
          </ul>
        </div>
      );
    }
    return null;
  }
  if (event.type === 'permission_request') return null;
  if (event.type === 'lifecycle' && isInterrupted(event.payload)) {
    return <div className="text-muted">Interrupted</div>;
  }
  if (eventName === 'model_mismatch') {
    return (
      <div className="text-tool">
        model mismatch: ran on{' '}
        <span className="font-medium">{(Array.isArray(observed) ? observed : []).join(', ')}</span> (task pinned{' '}
        <span className="font-medium">{String(expected)}</span>)
      </div>
    );
  }
  if (eventName === 'steer_delivered' || eventName === 'steer_queued') {
    const queued = eventName === 'steer_queued';
    return (
      <div className="rounded-md bg-accent-tint px-2 py-1 text-ink">
        <span className={`${labelType} mr-2 text-accent`}>{queued ? 'steer queued' : 'steering'}</span>
        <span className="whitespace-pre-wrap">{String(text ?? '')}</span>
      </div>
    );
  }
  if (eventName === 'progress-nudge') {
    return (
      <div className="rounded-md bg-accent-tint px-2 py-1 text-ink">
        <span className={`${labelType} mr-2 text-accent`}>progress nudge</span>
        <span>
          Redirected before a guardrail trip
          {pattern ? ` — ${String(pattern)}` : ''}
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
  if (eventName === 'guardrail-tripped') {
    return (
      <div className="text-fail">
        Guardrail tripped —{' '}
        <span className="font-medium">{guardrailDimensionLabel(String(dimension))}</span>
        {reason ? `: ${String(reason)}` : ''}
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
          if (item.variant === 'thought') {
            return (
              <Markdown
                key={item.key}
                source={item.text}
                className={`${READ_MEASURE} border-l border-edge pl-3 text-small italic text-muted`}
              />
            );
          }
          return <Markdown key={item.key} source={item.text} className={`${READ_MEASURE} text-ink`} />;
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
        <p className="text-small text-faint">
          <span className="tabular-nums">{hidden.toLocaleString()}</span> earlier{' '}
          {hidden === 1 ? 'event' : 'events'} hidden
        </p>
      )}
      {rendered}
      {events.length === 0 && <p className="text-muted">No events.</p>}
    </div>
  );
}

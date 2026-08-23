import { useMemo, type JSX } from 'react';
import { coalesceEvents, type StreamItem } from '../event-stream-model';
import type { RunLogEvent } from '../types';

type Glyph = 'think' | 'chat' | 'eye' | 'pencil' | 'file' | 'terminal' | 'check' | 'dot';

const GLYPHS: Record<Glyph, JSX.Element> = {
  think: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
    </>
  ),
  chat: <path d="M8 10h8M8 14h5M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  pencil: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M12 11v6M9 14h6" />
    </>
  ),
  terminal: (
    <>
      <rect height="16" rx="2" width="18" x="3" y="4" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  dot: <circle cx="12" cy="12" r="3" />,
};

function IconChip({ glyph }: { glyph: Glyph }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="12"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={glyph === 'check' ? 3 : 2}
      viewBox="0 0 24 24"
      width="12"
    >
      {GLYPHS[glyph]}
    </svg>
  );
}

function toolGlyph(verb: string): Glyph {
  const v = verb.toLowerCase();
  if (v.includes('read')) return 'eye';
  if (v.includes('write')) return 'file';
  if (v.includes('edit')) return 'pencil';
  if (v.includes('bash') || v.includes('shell') || v.includes('run') || v.includes('exec')) return 'terminal';
  return 'dot';
}

interface Row {
  key: number;
  ts: number;
  glyph: Glyph;
  label: string;
  ok: boolean;
  failed: boolean;
  text?: { body: string; muted: boolean };
  path?: string;
}

function toRow(item: StreamItem<RunLogEvent>, ts: number): Row {
  if (item.kind === 'text') {
    const thought = item.variant === 'thought';
    return {
      key: item.key,
      ts,
      glyph: thought ? 'think' : 'chat',
      label: thought ? 'Thought' : 'Assistant',
      ok: false,
      failed: false,
      text: { body: item.text, muted: thought },
    };
  }
  if (item.kind === 'tool') {
    const title = item.tool.title?.trim() || 'Tool call';
    const space = title.indexOf(' ');
    const verb = space === -1 ? title : title.slice(0, space);
    const target = space === -1 ? '' : title.slice(space + 1).trim();
    return {
      key: item.key,
      ts,
      glyph: toolGlyph(item.tool.toolKind ?? verb),
      label: verb,
      ok: item.tool.status === 'completed',
      failed: item.tool.status === 'failed',
      path: target || undefined,
    };
  }
  const payload = item.event.payload as { event?: unknown; text?: unknown } | null;
  const label = typeof payload?.event === 'string' ? payload.event : item.event.type;
  const body = typeof payload?.text === 'string' ? payload.text : undefined;
  return {
    key: item.key,
    ts: item.event.ts,
    glyph: 'dot',
    label,
    ok: false,
    failed: false,
    text: body ? { body, muted: true } : undefined,
  };
}

function timestamp(ts: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function TranscriptTimeline({ events }: { events: RunLogEvent[] }) {
  const rows = useMemo(() => {
    const tsById = new Map(events.map((e) => [e.id, e.ts]));
    return coalesceEvents<RunLogEvent>(events).map((item) => toRow(item, tsById.get(item.key) ?? 0));
  }, [events]);

  if (rows.length === 0) {
    return <p className="text-muted">No session transcript recorded.</p>;
  }

  return (
    <ol className="overflow-hidden rounded-xl border border-hairline bg-surface py-1.5">
      {rows.map((row, i) => {
        const chip = row.ok
          ? 'bg-merged-tint text-merged'
          : row.failed
            ? 'bg-raised text-fail'
            : 'bg-raised text-muted';
        return (
          <li key={row.key} className="relative flex gap-[14px] px-[18px] py-[11px]">
            <span
              aria-hidden="true"
              className={`absolute left-[29px] w-0.5 bg-hairline ${i === 0 ? 'top-[23px]' : 'top-0'} ${
                i === rows.length - 1 ? 'bottom-[calc(100%-23px)]' : 'bottom-0'
              }`}
            />
            <span className={`relative z-10 grid h-6 w-6 flex-none place-items-center rounded-[7px] ${chip}`}>
              <IconChip glyph={row.glyph} />
            </span>
            <div className="min-w-0 flex-1 pt-px">
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.08em] text-faint">
                <span>{row.label}</span>
                <span className="ml-auto font-data text-[11px] font-normal tracking-normal text-faint">
                  {timestamp(row.ts)}
                </span>
              </div>
              {row.path && (
                <div className="mt-1 whitespace-pre-wrap break-words font-data text-[12.5px] text-accent">
                  {row.path}
                </div>
              )}
              {row.text && (
                <p
                  className={`mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed ${
                    row.text.muted ? 'italic text-muted' : 'text-ink'
                  }`}
                >
                  {row.text.body}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

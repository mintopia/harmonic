import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  NO_THREAD_FILTER,
  type ServerThreadFilter,
  bodyParts,
  countLine,
  epicOptions,
  filterThreads,
  resolveSelectedThread,
  segmentThread,
  taskOptions,
  threadEpicCaption,
  threadParticipantsLine,
  threadTitle,
  type Identity,
  type Receipt,
  totalMessages,
  type TranscriptGroup,
  type TranscriptMessage,
} from '../agent-messages-model';
import { isAtLiveEdge } from '../follow-tail-model';
import { elapsedShort } from '../relative-time';
import type { AgentMessageThread } from '../types';
import { panelTitle } from '../ui';
import { useNow } from '../useNow';
import { EmptyState } from './EmptyState';
import { HarnessGlyph } from './HarnessGlyph';
import { Icon } from './Icon';
import { LoadError } from './LoadError';
import { Switch } from './Switch';

const IDENTITY_CLASS: Record<Identity, string> = {
  1: '[--id:var(--hm-id-1)]',
  2: '[--id:var(--hm-id-2)]',
  3: '[--id:var(--hm-id-3)]',
};

const SELECT_LABEL =
  'inline-flex min-h-9 items-center gap-1.5 rounded-md border border-edge bg-field pl-2.5 text-ink focus-within:border-accent';
const SELECT =
  'hm-select cursor-pointer bg-transparent py-1.5 pl-0 pr-7 text-ink focus:outline-none';
const SEPARATOR =
  "my-3.5 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint before:flex-1 before:border-t before:border-hairline before:content-[''] after:flex-1 after:border-t after:border-hairline after:content-['']";

function ThreadRow({
  thread,
  selected,
  now,
  onSelect,
}: {
  thread: AgentMessageThread;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-current={selected}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        className={`cursor-pointer rounded-md border-l-2 py-2 pl-2.5 pr-2 transition-colors duration-150 ${
          selected ? 'border-accent bg-raised' : 'border-transparent hover:bg-raised'
        }`}
      >
        <div className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className={`mt-[7px] size-1.5 shrink-0 rounded-full ${thread.live ? 'bg-running-dot motion-safe:animate-dot-pulse' : 'bg-blocked'}`}
          />
          <span
            className={`min-w-0 flex-1 text-data font-semibold leading-[1.4] ${
              selected ? 'line-clamp-2 text-ink' : 'truncate text-muted'
            }`}
          >
            {threadTitle(thread)}
          </span>
          <span className="shrink-0 pt-px font-data text-small tabular-nums text-faint">
            {elapsedShort(thread.latestAt, now)}
          </span>
        </div>
        <div className="mt-0.5 truncate pl-3.5 text-small text-faint">{threadParticipantsLine(thread)}</div>
      </div>
    </li>
  );
}

function MessageBody({ text }: { text: string }) {
  return (
    <div className="max-w-[68ch] whitespace-pre-wrap text-body leading-normal text-ink [overflow-wrap:anywhere]">
      {bodyParts(text).map((part, i) =>
        part.code ? (
          <code
            key={i}
            className="rounded-md border border-hairline bg-sunken px-[5px] font-data text-small text-syntax-title"
          >
            {part.value}
          </code>
        ) : (
          <Fragment key={i}>{part.value}</Fragment>
        ),
      )}
    </div>
  );
}

function ReceiptMark({ receipt }: { receipt: Receipt }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {receipt.label}
      <span
        role="img"
        aria-label={receipt.describe}
        className={
          receipt.state === 'refused' ? 'font-bold text-fail' : 'font-data tracking-[-0.1em] text-muted'
        }
      >
        {receipt.tick}
      </span>
      {receipt.tail && <span className="text-faint">{receipt.tail}</span>}
    </span>
  );
}

function Message({ message, first }: { message: TranscriptMessage; first: boolean }) {
  const single = message.receipts.length === 1;
  return (
    <div className={`relative min-w-0 ${first ? 'mt-1' : 'mt-2.5'}`}>
      {message.quote && (
        <div className="mb-1 flex max-w-[68ch] gap-1.5 overflow-hidden border-l-2 border-edge-strong py-px pl-2 text-small leading-[1.4] text-muted">
          <b className="whitespace-nowrap font-semibold text-ink">
            ↵ {message.quote.sender} {message.quote.time}
          </b>
          <span className="min-w-0 truncate">{message.quote.text}</span>
        </div>
      )}
      <MessageBody text={message.text} />
      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-small text-muted">
        <span className="text-faint">to {message.to}</span>
        {message.receipts.map((receipt) =>
          single ? (
            <ReceiptMark key={receipt.taskId} receipt={{ ...receipt, label: '' }} />
          ) : (
            <ReceiptMark key={receipt.taskId} receipt={receipt} />
          ),
        )}
      </div>
    </div>
  );
}

function Group({ group }: { group: TranscriptGroup }) {
  return (
    <div className={`mt-5 grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 ${group.identity ? IDENTITY_CLASS[group.identity] : ''}`}>
      <span
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-md bg-raised text-muted shadow-[0_0_0_2px_var(--id,var(--hm-edge-strong))]"
      >
        <HarnessGlyph harness={group.harness} />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2 leading-[1.3]">
          <span className="text-data font-bold text-[var(--id,var(--hm-ink))]">{group.name}</span>
          {group.harnessLabel && <span className="text-small text-muted">· {group.harnessLabel}</span>}
          <span className="font-data text-[11px] text-faint">{group.time}</span>
        </div>
        {group.messages.map((message, i) => (
          <Message key={message.id} message={message} first={i === 0} />
        ))}
      </div>
    </div>
  );
}

function Transcript({ thread, now }: { thread: AgentMessageThread; now: number }) {
  const items = useMemo(() => segmentThread(thread, now), [thread, now]);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const count = thread.messages.length;

  useEffect(() => {
    following.current = true;
  }, [thread.threadId]);
  useEffect(() => {
    const el = scroll.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [thread.threadId, count]);

  return (
    <div
      ref={scroll}
      onScroll={(e) => {
        following.current = isAtLiveEdge(e.currentTarget);
      }}
      className="flex-1 overflow-y-auto bg-canvas"
    >
      <div className="mx-auto max-w-4xl px-4 pb-5 pt-3 max-rail:px-3">
        {items.map((item) =>
          item.kind === 'group' ? (
            <Group key={item.key} group={item} />
          ) : (
            <div key={item.key} className={SEPARATOR}>
              {item.label}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export interface ThreadsView {
  threads: AgentMessageThread[];
  total: number;
  totalMessages: number;
}

export function AgentMessagesTab({
  view,
  optionThreads,
  filter,
  onFilterChange,
  error,
  onRetry,
}: {
  view: ThreadsView | null;
  optionThreads: AgentMessageThread[];
  filter: ServerThreadFilter;
  onFilterChange: (filter: ServerThreadFilter) => void;
  error: string | null;
  onRetry: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const now = useNow(true);

  const all = useMemo(() => view?.threads ?? [], [view]);
  const visible = useMemo(() => filterThreads(all, { ...NO_THREAD_FILTER, query }), [all, query]);
  const selected = resolveSelectedThread(visible, selectedId);
  const epics = useMemo(() => epicOptions(optionThreads), [optionThreads]);
  const tasks = useMemo(() => taskOptions(optionThreads, filter.epicId), [optionThreads, filter.epicId]);

  if (view === null) {
    return error ? (
      <LoadError message={error} onRetry={onRetry} />
    ) : (
      <div className="h-24 animate-pulse rounded-lg border border-edge motion-reduce:animate-none" />
    );
  }

  const select = (id: string) => {
    setSelectedId(id);
    setShowList(false);
  };

  return (
    <div id="settings-panel-messages" role="tabpanel" aria-labelledby="settings-tab-messages">
      {error && <LoadError className="mb-3.5" message={error} onRetry={onRetry} />}
      <div className="mb-3.5 flex flex-wrap items-center gap-3 max-rail:gap-2">
        <label className={`${SELECT_LABEL} max-rail:basis-full`}>
          <span className="text-small font-medium text-muted">Epic</span>
          <select
            className={SELECT}
            value={filter.epicId ?? ''}
            onChange={(e) => {
              const epicId = e.target.value === '' ? null : Number(e.target.value);
              onFilterChange({ ...filter, epicId, taskId: null });
            }}
          >
            <option value="">All Epics</option>
            {epics.map((id) => (
              <option key={id} value={id}>
                Epic #{id}
              </option>
            ))}
          </select>
        </label>
        <label className={`${SELECT_LABEL} max-rail:basis-full`}>
          <span className="text-small font-medium text-muted">Task</span>
          <select
            className={SELECT}
            value={filter.taskId ?? ''}
            onChange={(e) => onFilterChange({ ...filter, taskId: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">All Tasks</option>
            {tasks.map((task) => (
              <option key={task.taskId} value={task.taskId}>
                {task.label}
              </option>
            ))}
          </select>
        </label>
        <Switch checked={filter.liveOnly} onChange={(liveOnly) => onFilterChange({ ...filter, liveOnly })}>
          <span className="text-small font-medium">Only live</span>
        </Switch>
        <div className="flex-1 max-rail:hidden" />
        <span role="status" className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">
          {query.trim() ? countLine(visible.length, totalMessages(visible)) : countLine(view.total, view.totalMessages)}
        </span>
      </div>

      <div className="relative flex h-[1020px] max-h-[calc(100vh-14rem)] min-h-[34rem] overflow-hidden rounded-lg border border-edge bg-canvas">
        <aside
          aria-label="Threads"
          className={`flex w-[272px] flex-none flex-col overflow-hidden border-r border-edge bg-shell max-rail:w-full max-rail:border-r-0 ${
            showList ? '' : 'max-rail:hidden'
          }`}
        >
          <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
            <span className={panelTitle}>Threads</span>
          </div>
          <div className="px-3 pt-2.5">
            <div className="flex items-center gap-2 rounded-md border border-edge bg-field px-2.5 py-1.5 text-faint focus-within:border-accent">
              <Icon name="search" className="size-3.5 shrink-0" />
              <input
                type="search"
                aria-label="Filter threads"
                placeholder="Filter threads"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-small text-ink outline-none placeholder:text-faint"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {all.length === 0 ? (
              <EmptyState className="mt-10 px-2" title="No Agent Messages yet">
                Threads appear here when Tasks message each other.
              </EmptyState>
            ) : visible.length === 0 ? (
              <p className="mt-8 px-2 text-center text-small text-muted">No threads match.</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {visible.map((thread) => (
                  <ThreadRow
                    key={thread.threadId}
                    thread={thread}
                    selected={thread.threadId === selected?.threadId}
                    now={now}
                    onSelect={() => select(thread.threadId)}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section
          aria-label="Thread transcript"
          className={`flex min-w-0 flex-1 flex-col ${showList ? 'max-rail:hidden' : ''}`}
        >
          {selected ? (
            <>
              <div className="flex items-center gap-2.5 border-b border-hairline bg-shell px-4 py-3 max-rail:px-2.5 max-rail:py-2">
                <button
                  type="button"
                  aria-label="Back to threads"
                  onClick={() => setShowList(true)}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-edge bg-surface px-2.5 text-small font-medium text-muted hover:text-ink rail:hidden"
                >
                  <Icon name="chevron-left" className="size-3.5" />
                  Threads
                </button>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-bold uppercase tracking-[0.09em] text-faint">
                    {threadEpicCaption(selected)}
                  </div>
                  <h2 className="mt-0.5 text-title font-semibold leading-[1.35] max-rail:text-data">
                    {threadTitle(selected)}
                  </h2>
                </div>
              </div>
              <Transcript thread={selected} now={now} />
            </>
          ) : (
            <div className="flex-1 bg-canvas">
              <EmptyState title="No thread selected">Pick a thread to read the conversation.</EmptyState>
            </div>
          )}
          <div
            role="status"
            className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-edge bg-surface px-4 py-2.5 text-muted"
          >
            <Icon name="eye" className="size-3.5" />
            <span>Read-only — steer a Task to intervene</span>
            <span className="ml-auto text-small text-faint max-rail:ml-0">
              <b className="font-data font-normal text-muted">✓</b> queued ·{' '}
              <b className="font-data font-normal text-muted">✓✓</b> delivered ·{' '}
              <b className="font-data font-normal text-muted">◷</b> held ·{' '}
              <b className="font-data font-normal text-fail">✕</b> refused
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

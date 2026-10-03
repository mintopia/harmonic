import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  NO_THREAD_FILTER,
  type AgentCard,
  agentCards,
  epicKey,
  showWorkspaceBadge,
  workspaceOptions,
  type ServerThreadFilter,
  type ThreadsView,
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
  threadsCapHint,
  trappedFocusIndex,
  type Identity,
  type Receipt,
  totalMessages,
  type TranscriptGroup,
  type TranscriptMessage,
} from '../agent-messages-model';
import { isAtLiveEdge } from '../follow-tail-model';
import { elapsedShort } from '../relative-time';
import type { AgentMessageThread } from '../types';
import { panelTitle, stateChip } from '../ui';
import { taskKey } from '../id-format';
import { isRailLayout } from '../useRailBreakpoint';
import { useNow } from '../useNow';
import { EmptyState } from './EmptyState';
import { HarnessGlyph } from './HarnessGlyph';
import { Icon } from './Icon';
import { LoadError } from './LoadError';
import { Switch } from './Switch';
import { panelId, tabId } from './Tabs';

const IDENTITY_CLASS: Record<Identity, string> = {
  1: '[--id:var(--hm-id-1)]',
  2: '[--id:var(--hm-id-2)]',
  3: '[--id:var(--hm-id-3)]',
};

const SELECT_LABEL =
  'inline-flex min-h-9 items-center gap-1.5 rounded-md border border-edge bg-field pl-2.5 text-ink focus-within:border-accent';
const SELECT =
  'hm-select cursor-pointer bg-transparent py-1.5 pl-0 pr-7 text-ink focus:outline-none max-rail:flex-1';
const SEPARATOR =
  "my-3.5 flex items-center gap-3 text-micro font-semibold uppercase tracking-caps-tight text-faint before:flex-1 before:border-t before:border-hairline before:content-[''] after:flex-1 after:border-t after:border-hairline after:content-['']";

function FilterSelect({
  label,
  value,
  allLabel,
  options,
  onChange,
}: {
  label: string;
  value: string;
  allLabel: string;
  options: readonly { value: string | number; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className={`${SELECT_LABEL} max-rail:basis-full`}>
      <span className="text-small font-medium text-muted">{label}</span>
      <select className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ThreadRow({
  thread,
  selected,
  badge,
  now,
  onSelect,
}: {
  thread: AgentMessageThread;
  selected: boolean;
  badge: boolean;
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
        <div className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-small text-faint">
          {badge && (
            <span className="max-w-[40%] shrink-0 truncate rounded-sm bg-raised px-1.5 text-micro font-semibold text-muted">
              {thread.workspaceName}
            </span>
          )}
          <span className="min-w-0 truncate">{threadParticipantsLine(thread)}</span>
        </div>
      </div>
    </li>
  );
}

function AgentCardView({ card, workspaceId }: { card: AgentCard; workspaceId: number }) {
  if (card.deleted) {
    return (
      <li className="rounded-md border border-hairline bg-sunken px-3 py-2.5 text-small text-faint opacity-80">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="grid size-6 place-items-center rounded-md bg-raised text-faint">
            <HarnessGlyph harness={null} className="size-[13px]" />
          </span>
          <span className="font-data">{taskKey(card.taskId)}</span>
          <span>deleted Task</span>
        </div>
      </li>
    );
  }
  return (
    <li
      className={`rounded-md border border-hairline bg-sunken px-3 py-2.5 text-small ${card.identity ? IDENTITY_CLASS[card.identity] : ''}`}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-raised text-muted shadow-[0_0_0_2px_var(--id,var(--hm-edge-strong))]"
        >
          <HarnessGlyph harness={card.harness} className="size-[13px]" />
        </span>
        <div className="min-w-0">
          <div className="text-data font-semibold leading-[1.3] [overflow-wrap:anywhere]">
            <span className="font-data text-small font-normal text-faint">{taskKey(card.taskId)}</span> {card.title}
          </div>
          <div className="mt-0.5 text-muted">
            {card.harnessLabel}
            {card.model && (
              <>
                {' · '}
                <code className="rounded-md border border-hairline bg-surface px-[5px] font-data text-micro text-syntax-title">
                  {card.model}
                </code>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {card.state && <span className={stateChip(card.state)}>{card.state.replace(/-/g, ' ')}</span>}
        {card.betweenAttempts && <span className="text-faint">between Attempts</span>}
        {card.attemptLabel && <span className="text-faint">{card.attemptLabel}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2 text-ink">
        <span className={`min-w-[3ch] font-data text-small ${card.atCap ? 'text-fail' : ''}`}>{card.sendsCount}</span>
        <span aria-hidden="true" className="h-[5px] flex-1 overflow-hidden rounded-full bg-raised">
          <span
            className={`block h-full rounded-full ${card.atCap ? 'bg-fail' : 'bg-muted'}`}
            style={{ width: `${Math.round(card.sendsRatio * 100)}%` }}
          />
        </span>
        <span className={card.atCap ? 'text-fail' : 'text-faint'}>sends</span>
      </div>
      <div className="mt-2 flex justify-between border-t border-hairline pt-1.5 text-muted">
        <span>Last message</span>
        <span className="font-data text-small text-ink">{card.lastMessage}</span>
      </div>
      <a
        href={`/workspace/${workspaceId}/task/${card.taskId}`}
        className="mt-1.5 inline-block font-semibold text-accent hover:underline"
      >
        Open Task →
      </a>
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
      {receipt.showLabel && receipt.label}
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
        {message.receipts.map((receipt) => (
          <ReceiptMark key={receipt.taskId} receipt={receipt} />
        ))}
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
          {(group.harnessLabel || group.attemptLabel) && (
            <span className="text-small text-muted">{[group.harnessLabel, group.attemptLabel].filter(Boolean).map((part) => `· ${part}`).join(' ')}</span>
          )}
          <span className="font-data text-micro text-faint">{group.time}</span>
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

export function AgentMessagesTab({
  global,
  view,
  optionThreads,
  filter,
  onFilterChange,
  error,
  onRetry,
  onLoadMore,
}: {
  global: boolean;
  view: ThreadsView | null;
  optionThreads: AgentMessageThread[];
  filter: ServerThreadFilter;
  onFilterChange: (filter: ServerThreadFilter) => void;
  error: string | null;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const now = useNow(true);
  const drawerRef = useRef<HTMLElement>(null);

  const all = useMemo(() => view?.threads ?? [], [view]);
  const visible = useMemo(() => filterThreads(all, { ...NO_THREAD_FILTER, query }), [all, query]);
  const selected = resolveSelectedThread(visible, selectedId);
  const workspaces = useMemo(() => workspaceOptions(optionThreads), [optionThreads]);
  const epics = useMemo(
    () => epicOptions(optionThreads, filter.workspaceId, global && filter.workspaceId === null),
    [optionThreads, filter.workspaceId, global],
  );
  const tasks = useMemo(
    () => taskOptions(optionThreads, filter.epicId, filter.workspaceId),
    [optionThreads, filter.epicId, filter.workspaceId],
  );
  const cards = useMemo(() => (selected ? agentCards(selected) : []), [selected]);
  const badge = showWorkspaceBadge(global, filter);
  const capHint = threadsCapHint(all.length, view?.total ?? 0);

  useEffect(() => {
    if (!overlayOpen) return;
    const drawer = drawerRef.current;
    const opener = document.activeElement;
    const focusable = () =>
      Array.from(drawer?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? []);
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOverlayOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const index = trappedFocusIndex(items.findIndex((el) => el === document.activeElement), items.length, event.shiftKey);
      if (index === null) return;
      event.preventDefault();
      items[index]?.focus();
    };
    const onResize = () => {
      if (isRailLayout()) setOverlayOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [overlayOpen]);

  if (view === null) {
    return error ? (
      <LoadError message={error} onRetry={onRetry} />
    ) : (
      <div role="status" aria-label="Loading Agent Messages" className="h-24 animate-pulse rounded-lg border border-edge motion-reduce:animate-none" />
    );
  }

  const select = (id: string) => {
    setSelectedId(id);
    setShowList(false);
  };
  const toggleDrawer = () => {
    if (isRailLayout()) setDrawerOpen((open) => !open);
    else setOverlayOpen((open) => !open);
  };

  return (
    <div id={panelId('messages')} role="tabpanel" aria-labelledby={tabId('messages')}>
      {error && <LoadError className="mb-3.5" message={error} onRetry={onRetry} />}
      <div className="mb-3.5 flex flex-wrap items-center gap-3 max-rail:gap-2">
        {global && (
          <FilterSelect
            label="Workspace"
            value={filter.workspaceId === null ? '' : String(filter.workspaceId)}
            allLabel="All Workspaces"
            options={workspaces.map((ws) => ({ value: ws.id, label: ws.name }))}
            onChange={(raw) => onFilterChange({ ...filter, workspaceId: raw === '' ? null : Number(raw), epicId: null, taskId: null })}
          />
        )}
        <FilterSelect
          label="Epic"
          value={filter.epicId !== null && filter.workspaceId !== null ? epicKey(filter.workspaceId, filter.epicId) : ''}
          allLabel="All Epics"
          options={epics.map((option) => ({ value: option.key, label: option.label }))}
          onChange={(key) => {
            const option = epics.find((o) => o.key === key);
            onFilterChange({
              ...filter,
              workspaceId: option ? option.workspaceId : filter.workspaceId,
              epicId: option ? option.epicId : null,
              taskId: null,
            });
          }}
        />
        <FilterSelect
          label="Task"
          value={filter.taskId === null ? '' : String(filter.taskId)}
          allLabel="All Tasks"
          options={tasks.map((task) => ({ value: task.taskId, label: task.label }))}
          onChange={(raw) => onFilterChange({ ...filter, taskId: raw === '' ? null : Number(raw) })}
        />
        <Switch checked={filter.liveOnly} onChange={(liveOnly) => onFilterChange({ ...filter, liveOnly })}>
          <span className="text-small font-medium">Only live</span>
        </Switch>
        <div className="flex-1 max-rail:hidden" />
        <span role="status" className="text-micro font-semibold uppercase tracking-caps text-muted">
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
          {capHint && (
            <div className="flex items-center gap-3 px-4 pt-2 text-small text-faint">
              <span>{capHint}</span>
              <button type="button" className="text-ink underline" onClick={onLoadMore}>
                Load more
              </button>
            </div>
          )}
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
                    badge={badge}
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
                  <div className="text-micro font-bold uppercase tracking-caps text-faint">
                    {threadEpicCaption(selected)}
                  </div>
                  <h2 className="mt-0.5 text-title font-semibold leading-[1.35] max-rail:text-data">
                    {threadTitle(selected)}
                  </h2>
                </div>
                <button
                  type="button"
                  aria-label="Toggle agents panel"
                  aria-expanded={overlayOpen || drawerOpen}
                  onClick={toggleDrawer}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-edge bg-surface px-2.5 text-small font-medium text-muted hover:text-ink"
                >
                  <Icon name="agents" className="size-3.5" />
                  <span className="max-rail:hidden">Agents</span>
                </button>
              </div>
              <Transcript thread={selected} now={now} />
            </>
          ) : (
            <div className="flex-1 bg-canvas">
              <EmptyState title="No thread selected">Pick a thread to read the conversation.</EmptyState>
            </div>
          )}
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-edge bg-surface px-4 py-2.5 text-muted"
          >
            <span className="inline-flex items-center gap-4">
              <Icon name="eye" className="size-3.5" />
              <span>Read-only — steer a Task to intervene</span>
            </span>
            <span className="ml-auto text-small text-faint max-rail:ml-0">
              <b className="font-data font-normal text-muted">✓</b> queued ·{' '}
              <b className="font-data font-normal text-muted">✓✓</b> delivered ·{' '}
              <b className="font-data font-normal text-muted">◷</b> held ·{' '}
              <b className="font-data font-normal text-fail">✕</b> refused
            </span>
          </div>
        </section>

        {overlayOpen && selected && (
          <div aria-hidden="true" onClick={() => setOverlayOpen(false)} className="absolute inset-0 z-[25] bg-black/50 rail:hidden" />
        )}
        {selected && (
          <aside
            ref={drawerRef}
            aria-label="Thread agents"
            role={overlayOpen ? 'dialog' : undefined}
            aria-modal={overlayOpen || undefined}
            className={`w-72 flex-none flex-col overflow-hidden border-l border-edge bg-shell max-rail:absolute max-rail:inset-y-0 max-rail:right-0 max-rail:z-30 max-rail:w-full max-rail:max-w-80 max-rail:shadow-float ${
              drawerOpen ? 'rail:flex' : 'rail:hidden'
            } ${overlayOpen ? 'max-rail:flex' : 'max-rail:hidden'}`}
          >
            <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
              <span className={panelTitle}>Agents</span>
              <button
                type="button"
                onClick={toggleDrawer}
                className="inline-flex min-h-9 items-center rounded-md px-2.5 text-small font-medium text-muted hover:text-ink"
              >
                Hide
              </button>
            </div>
            <ul className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-4">
              {cards.map((card) => (
                <AgentCardView key={card.taskId} card={card} workspaceId={selected.workspaceId} />
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  );
}

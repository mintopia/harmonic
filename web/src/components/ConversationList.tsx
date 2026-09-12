import { useMemo, useState } from 'react';
import type { AttentionState } from '../conversation-attention-model';
import { conversationDisplayTitle } from '../conversation-list-model';
import type { Conversation } from '../types';
import { btnQuiet, panelTitle, touchTarget } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { providerLabel } from './TaskIdentity';

function relativeTime(ts: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function statusDot(conversation: Conversation, needsAttention: boolean): string {
  if (needsAttention) return 'bg-await-dot';
  if (conversation.state === 'ended') return 'bg-blocked';
  return 'bg-ready-dot';
}

function ConversationRow({
  conversation,
  needsAttention,
  selected,
  now,
  onSelect,
  onDelete,
}: {
  conversation: Conversation;
  needsAttention: boolean;
  selected: boolean;
  now: number;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const title = conversationDisplayTitle(conversation.title);
  const ended = conversation.state === 'ended';

  return (
    <li className="group relative">
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
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${statusDot(conversation, needsAttention)}`} />
          <span className={`min-w-0 flex-1 truncate text-data font-semibold ${selected ? 'text-ink' : 'text-muted'}`}>
            {title}
          </span>
          <span className="shrink-0 font-data text-small tabular-nums text-faint">{relativeTime(conversation.updatedAt, now)}</span>
        </div>
        <div className="mt-0.5 truncate pl-3.5 text-small text-faint">
          {needsAttention ? (
            <span className="font-medium text-await">Needs you</span>
          ) : ended ? (
            <span>{providerLabel(conversation.harness)} · ended</span>
          ) : (
            <span>
              {providerLabel(conversation.harness)} · {conversation.model}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        aria-label={`Delete conversation ${title}`}
        className={`absolute right-1.5 top-1.5 ${touchTarget} ${btnQuiet} opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100`}
        onClick={() => setConfirming(true)}
      >
        <Icon name="trash" className="size-4" />
      </button>
      {confirming && (
        <ConfirmDialog
          label={`Delete conversation ${title}`}
          title={`Delete "${title}"?`}
          confirmLabel="Delete"
          tone="danger"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onDelete();
          }}
        >
          This permanently deletes the conversation and its history. This cannot be undone.
        </ConfirmDialog>
      )}
    </li>
  );
}

type ConversationListProps = {
  conversations: Conversation[];
  attention: AttentionState;
  selectedId?: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  onDelete: (id: number) => void;
} & (
  | { fullPage: true }
  | { fullPage?: false; onExpand: () => void; onClose: () => void }
);

export function ConversationList(props: ConversationListProps) {
  const { conversations, attention, selectedId, onSelect, onNew, onDelete } = props;
  const [query, setQuery] = useState('');
  const [now] = useState(() => Date.now());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      [conversationDisplayTitle(c.title), providerLabel(c.harness), c.model]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [conversations, query]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
        <span className={panelTitle}>Conversations</span>
        <div className="flex-1" />
        <button
          className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-md bg-accent px-2.5 py-1 text-small font-semibold text-on-accent transition-colors duration-150 hover:bg-accent-hot"
          onClick={onNew}
        >
          <Icon name="plus" />
          New
        </button>
        {!props.fullPage && (
          <>
            <button
              aria-label="Expand to full view"
              className={`${touchTarget} ${btnQuiet}`}
              onClick={props.onExpand}
            >
              <Icon name="expand" />
            </button>
            <button aria-label="Close conversation panel" className={`${touchTarget} ${btnQuiet}`} onClick={props.onClose}>
              <Icon name="close" />
            </button>
          </>
        )}
      </div>

      {conversations.length > 0 && (
        <div className="px-3 pt-2.5">
          <div className="flex items-center gap-2 rounded-md border border-edge bg-field px-2.5 py-1.5 text-faint focus-within:border-accent">
            <Icon name="search" className="size-3.5 shrink-0" />
            <input
              type="search"
              aria-label="Search conversations"
              placeholder="Search conversations"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-small text-ink outline-none placeholder:text-faint"
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {conversations.length === 0 ? (
          <EmptyState className="mt-10 px-2" title="No conversations yet">
            Start a conversation to explore a repo or drive changes turn by turn, live.{' '}
            <span className="font-semibold text-ink">New conversation</span> is just above.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <p className="mt-8 px-2 text-center text-small text-muted">No conversations match “{query}”.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {filtered.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                needsAttention={attention.has(c.id)}
                selected={c.id === selectedId}
                now={now}
                onSelect={() => onSelect(c.id)}
                onDelete={() => onDelete(c.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

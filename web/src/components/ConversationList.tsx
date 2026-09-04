import type { AttentionState } from '../conversation-attention-model';
import { conversationDisplayTitle } from '../conversation-list-model';
import { formatTokens } from '../conversation-telemetry-model';
import { formatCost } from '../cost';
import type { Conversation } from '../types';
import { btnQuiet, btnQuietDestructive, conversationStateChip, panelTitle, touchTarget } from '../ui';
import { ArmedButton } from './ArmedButton';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';

function ConversationRow({
  conversation,
  needsAttention,
  onSelect,
  onDelete,
}: {
  conversation: Conversation;
  needsAttention: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const tokens = formatTokens(conversation.usage);
  const cost = formatCost(conversation.cost);
  const title = conversationDisplayTitle(conversation.title);

  return (
    <li className="group flex items-start gap-2 rounded-md px-2 py-2.5 transition-colors duration-150 hover:bg-raised">
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        className="min-w-0 flex-1 cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {needsAttention && (
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{title}</span>
          <span className={conversationStateChip(conversation.state)}>{conversation.state}</span>
        </div>
        <div className="mt-0.5 truncate text-small text-muted">
          {conversation.harness} · {conversation.model}
          {conversation.workingDir && (
            <>
              {' · '}
              <span className="font-data">{conversation.workingDir}</span>
            </>
          )}
          {` · ${tokens}`}
          {cost ? ` · ${cost}` : ''}
        </div>
      </div>
      <ArmedButton
        label="Delete"
        armedLabel="Delete?"
        ariaLabel={`Delete conversation ${title}`}
        className={`${btnQuietDestructive} shrink-0`}
        onConfirm={onDelete}
      />
    </li>
  );
}

export function ConversationList({
  conversations,
  attention,
  expanded,
  onSelect,
  onNew,
  onDelete,
  onToggleExpand,
  onClose,
}: {
  conversations: Conversation[];
  attention: AttentionState;
  expanded: boolean;
  onSelect: (id: number) => void;
  onNew: () => void;
  onDelete: (id: number) => void;
  onToggleExpand: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
        <span className={panelTitle}>Conversations</span>
        <div className="flex-1" />
        <button
          className="inline-flex min-h-9 items-center gap-1 whitespace-nowrap rounded-md bg-accent px-2.5 py-1 text-small font-semibold text-on-accent transition-colors duration-150 hover:bg-accent-hot"
          onClick={onNew}
        >
          <Icon name="plus" />
          New
        </button>
        <button
          aria-label={expanded ? 'Collapse to panel' : 'Expand to full view'}
          className={`${touchTarget} ${btnQuiet}`}
          onClick={onToggleExpand}
        >
          <Icon name={expanded ? 'collapse' : 'expand'} />
        </button>
        <button aria-label="Close conversation panel" className={`${touchTarget} ${btnQuiet}`} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {conversations.length === 0 ? (
          <EmptyState className="mt-10 px-2" title="No conversations yet">
            Start an interactive session to explore a repo or drive changes turn by turn — the agent
            works alongside you, live. <span className="font-semibold text-ink">New conversation</span> is
            just above.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                needsAttention={attention.has(c.id)}
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

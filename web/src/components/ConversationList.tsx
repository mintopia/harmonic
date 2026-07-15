import type { AttentionState } from '../conversation-attention-model';
import { conversationDisplayTitle } from '../conversation-list-model';
import { formatTokens } from '../conversation-telemetry-model';
import { formatCost } from '../cost';
import type { Conversation } from '../types';
import { btnPrimary, btnQuiet, btnQuietDestructive, conversationStateChip, headline } from '../ui';
import { Icon } from './Icon';

/**
 * One row of the history list (issue #15): title (falling back honestly to
 * "Untitled conversation"), a state chip, the harness/model/Working
 * Directory line, and a token/cost summary — the same figures the detail
 * view's telemetry strip reads, just at list density (one truncating
 * Data-role line per DESIGN.md's card metadata rule, even though these rows
 * aren't cards). The accent dot mirrors TaskDetail's tab-flag treatment: a
 * live "something changed here" cue, not a state color.
 */
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
    <li>
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
        className="group flex cursor-pointer items-start gap-2 rounded-md px-2 py-2.5 transition-colors duration-150 hover:bg-raised"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {needsAttention && (
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium text-ink">{title}</span>
            <span className={conversationStateChip(conversation.state)}>{conversation.state}</span>
          </div>
          <div className="mt-0.5 truncate font-data text-data text-muted">
            {conversation.harness} · {conversation.model} · {conversation.workingDir}
          </div>
          <div className="mt-0.5 font-data text-data text-faint">
            {tokens}
            {cost ? ` · ${cost}` : ''}
          </div>
        </div>
        <button
          type="button"
          aria-label={`Delete conversation ${title}`}
          className={`${btnQuietDestructive} shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

/**
 * The reverse-chronological Conversation history (issue #15): active and
 * ended alike, newest first — exactly the order the server already returns.
 * "New conversation" is the panel's one primary action here, mirroring the
 * top strip's "New task" (DESIGN.md's one-primary-per-view rule).
 */
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
        <span className={headline}>Conversations</span>
        <div className="flex-1" />
        <button className={btnPrimary} onClick={onNew}>
          New conversation
        </button>
        <button
          aria-label={expanded ? 'Collapse to panel' : 'Expand to full view'}
          className={btnQuiet}
          onClick={onToggleExpand}
        >
          <Icon name={expanded ? 'collapse' : 'expand'} />
        </button>
        <button aria-label="Close conversation panel" className={btnQuiet} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {conversations.length === 0 ? (
          <p className="p-2 text-muted">No conversations yet — start one above.</p>
        ) : (
          <ul className="divide-y divide-hairline">
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

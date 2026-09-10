import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { subscribe } from '../ws';
import type { AppConfig, Conversation, ConversationEvent, Workspace } from '../types';
import {
  chooseAlwaysAllowOptionId,
  permissionOptionLabel,
  type PendingPermission,
} from '../conversation-permissions-model';
import { clearConversationId, loadConversationId, storeConversationId } from '../conversation-storage';
import {
  computeContextUsage,
  formatColdCacheMessage,
  formatContextUsage,
  formatTokenBreakdown,
  formatTokens,
  lastConversationTurnAt,
} from '../conversation-telemetry-model';
import {
  applyAttentionMessage,
  clearAllAttention,
  clearAttention,
  hasAttention,
  NO_ATTENTION,
  type AttentionState,
} from '../conversation-attention-model';
import { conversationDisplayTitle, removeConversationById, upsertConversation } from '../conversation-list-model';
import { formatCost } from '../cost';
import { ConfirmDialog } from './ConfirmDialog';
import { ConversationList } from './ConversationList';
import { ElicitationPrompt } from './ElicitationPrompt';
import { PathTail } from './PathTail';
import { providerLabel } from './TaskIdentity';
import { Icon } from './Icon';
import { Composer } from './conversation/Composer';
import { StreamAnnouncer, Transcript } from './conversation/Transcript';
import { useConversationDetail } from './useConversationDetail';
import { toastError } from '../toast';
import {
  btnQuiet,
  btnQuietDestructive,
  field,
  panelTitle,
  permissionOptionButtonClass,
  toolChip,
  touchTarget,
  touchTargetInline,
} from '../ui';

function TelemetryStrip({ conversation, events }: { conversation: Conversation; events: ConversationEvent[] }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, []);

  const tokens = formatTokens(conversation.usage);
  const tokenBreakdown = formatTokenBreakdown(conversation.usage);
  const cost = formatCost(conversation.cost);
  const context = formatContextUsage(computeContextUsage(conversation));
  const coldCache = formatColdCacheMessage({
    lastTurnAt: lastConversationTurnAt(events) ?? conversation.updatedAt,
    cacheWarmSeconds: conversation.cacheWarmSeconds,
    now,
  });

  return (
    <div className="border-b border-hairline">
      <p className="px-4 py-2 text-small text-muted">
        {tokens === 'no usage yet' ? 'no usage yet' : `${tokens} tokens`}
        {' · '}
        {cost ?? '—'}
        {' · '}
        {context.value === '—' ? '—' : `${context.value} context`}
        {context.note ? ` · ${context.note}` : ''}
      </p>
      {tokenBreakdown && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-hairline px-4 py-2 text-small sm:grid-cols-4">
          {tokenBreakdown.map(({ label, value }) => (
            <div key={label} className="flex min-w-0 items-baseline justify-between gap-1.5 sm:block">
              <dt className="text-faint">{label}</dt>
              <dd className="font-data text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {coldCache && (
        <p role="status" className="bg-raised px-4 py-1.5 text-small text-muted">
          {coldCache}
        </p>
      )}
    </div>
  );
}

function PermissionPrompt({
  pending,
  workingDir,
  onAnswer,
}: {
  pending: PendingPermission;
  workingDir: string;
  onAnswer: (pending: PendingPermission, optionId: string, remember?: boolean) => Promise<void>;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const title = pending.request.toolCall?.title ?? pending.request.toolCall?.kind ?? 'Tool call';
  const kind = pending.request.toolCall?.kind;
  const alwaysAllowOptionId = chooseAlwaysAllowOptionId(pending.request.options);

  // When this prompt appears focus moves to its first choice. In
  // the same pass an assertive live region is filled — empty at first render,
  // populated a tick later — because an `aria-live` node inserted with its text
  // already present isn't reliably announced; only a change observed *after* the
  // node is in the tree is. Keyed per reqId-mounted instance, this runs once on
  // appear and never yanks focus back mid-decision.
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    firstOptionRef.current?.focus();
    setAnnouncement(`Permission request: ${title}. This turn is paused until you respond.`);
  }, [title]);

  const choose = async (key: string, optionId: string, remember?: boolean) => {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await onAnswer(pending, optionId, remember);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div
      role="group"
      aria-label={`Permission request: ${title}`}
      className="border-t border-hairline bg-running-tint px-4 py-3"
    >
      <div role="alert" className="sr-only">
        {announcement}
      </div>
      <p className="text-title font-semibold text-ink">Waiting for your decision</p>
      <div className="mt-1.5 flex items-center gap-2">
        <span className={toolChip}>permission</span>
        <span title={title} className="min-w-0 truncate text-muted">
          {title}
        </span>
      </div>
      <p className="mb-2.5 mt-1 text-small text-muted">This turn is paused until you respond.</p>
      <div className="flex flex-wrap items-center gap-2">
        {pending.request.options.map((option, index) => (
          <button
            key={option.optionId}
            ref={index === 0 ? firstOptionRef : undefined}
            type="button"
            disabled={busyKey !== null}
            className={permissionOptionButtonClass(option.kind)}
            onClick={() => choose(option.optionId, option.optionId)}
          >
            {option.name || permissionOptionLabel(option.kind)}
          </button>
        ))}
        {kind && workingDir && alwaysAllowOptionId && (
          <button
            type="button"
            disabled={busyKey !== null}
            className={`${btnQuiet} disabled:opacity-50`}
            onClick={() => choose('always-allow', alwaysAllowOptionId, true)}
          >
            Always allow {kind} in{' '}
            <span
              title={workingDir}
              className="inline-block max-w-[10rem] truncate align-bottom font-data text-data"
            >
              {workingDir}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function ConversationHeader({
  conversation,
  composing,
  expanded,
  onBack,
  onToggleExpand,
  onRename,
  onEnd,
  onDelete,
  onClose,
}: {
  conversation: Conversation | null;
  composing: boolean;
  expanded: boolean;
  onBack: () => void;
  onToggleExpand: () => void;
  onRename: (title: string | null) => Promise<void>;
  onEnd: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const startEdit = () => {
    setDraft(conversation?.title ?? '');
    setEditing(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const trimmed = draft.trim();
    try {
      await onRename(trimmed.length > 0 ? trimmed : null);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const title = composing ? 'New conversation' : conversationDisplayTitle(conversation?.title ?? null);

  return (
    <div className="border-b border-hairline px-4 py-3">
      <div className="flex items-center gap-1.5">
        <button aria-label="Back to conversations" className={`${touchTarget} ${btnQuiet}`} onClick={onBack}>
          <Icon name="arrow-left" />
        </button>
        {editing ? (
          <>
            <input
              aria-label="Conversation title"
              autoFocus
              className={`${field} min-w-0 flex-1 py-1`}
              value={draft}
              placeholder="Untitled conversation"
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  save();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
            />
            <button aria-label="Save title" className={`${touchTarget} ${btnQuiet}`} disabled={saving} onClick={save}>
              <Icon name="check" />
            </button>
            <button aria-label="Cancel rename" className={`${touchTarget} ${btnQuiet}`} disabled={saving} onClick={() => setEditing(false)}>
              <Icon name="close" />
            </button>
          </>
        ) : (
          <>
            <span className={`${panelTitle} min-w-0 flex-1 truncate`}>{title}</span>
            {conversation && (
              <button aria-label="Rename conversation" className={`${touchTarget} ${btnQuiet}`} onClick={startEdit}>
                <Icon name="edit" />
              </button>
            )}
          </>
        )}
        <button
          aria-label={expanded ? 'Collapse to panel' : 'Expand to full view'}
          className={`${touchTarget} ${btnQuiet}`}
          onClick={onToggleExpand}
        >
          <Icon name={expanded ? 'collapse' : 'expand'} />
        </button>
        {conversation?.state === 'active' && (
          <button className={`${touchTargetInline} ${btnQuiet}`} onClick={onEnd}>
            End
          </button>
        )}
        {conversation && (
          <button
            aria-label="Delete conversation"
            className={`${touchTargetInline} ${btnQuietDestructive}`}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </button>
        )}
        <button aria-label="Close conversation panel" className={`${touchTarget} ${btnQuiet}`} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {confirmingDelete && (
        <ConfirmDialog
          label={`Delete conversation ${title}`}
          title={`Delete "${title}"?`}
          confirmLabel="Delete"
          tone="danger"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            onDelete();
          }}
        >
          This permanently deletes the conversation and its history. This cannot be undone.
        </ConfirmDialog>
      )}
      {conversation && (
        <div className="mt-1 flex items-center gap-1.5 text-small text-muted">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              conversation.state === 'active' ? 'bg-muted' : 'bg-faint'
            }`}
            title={conversation.state}
          />
          <span className="sr-only">{conversation.state}</span>
          <span className="shrink-0">
            {providerLabel(conversation.harness)} · {conversation.model}
          </span>
          <span aria-hidden="true" className="shrink-0 text-faint">
            ·
          </span>
          <PathTail path={conversation.workingDir} className="flex-1 font-data" />
        </div>
      )}
    </div>
  );
}

type LauncherView = { kind: 'list' } | { kind: 'detail'; conversationId: number | null };

export function ConversationLauncher({
  config,
  workspace,
  conversationId,
  openConversationId,
  pendingPermission,
  onConversationOpened,
}: {
  config: AppConfig | null;
  workspace: Workspace | null;
  conversationId?: number | null;
  openConversationId: number | null;
  pendingPermission: PendingPermission | null;
  onConversationOpened: () => void;
}) {
  const workspaceId = workspace?.id ?? null;
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Re-adding the same class later still restarts the CSS animation (it only
  // replays on a genuine "gained the class" transition), so the flourish never
  // needs a remount, which would otherwise blow away in-progress Composer text.
  const [flourish, setFlourish] = useState(false);
  const flourishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flourishTimer.current) clearTimeout(flourishTimer.current);
    },
    [],
  );
  const toggleExpanded = () => {
    setExpanded((e) => !e);
    setFlourish(true);
    if (flourishTimer.current) clearTimeout(flourishTimer.current);
    flourishTimer.current = setTimeout(() => setFlourish(false), 150);
  };

  const [view, setView] = useState<LauncherView>(() => {
    const persisted = loadConversationId(localStorage);
    return persisted === null ? { kind: 'list' } : { kind: 'detail', conversationId: persisted };
  });
  const focusedId = view.kind === 'detail' ? view.conversationId : null;
  const [openedPendingPermission, setOpenedPendingPermission] = useState<PendingPermission | null>(null);
  const clearOpenedPendingPermission = useCallback(() => setOpenedPendingPermission(null), []);
  // The route-driven auto-open must fire once per distinct deep-linked conversation, not on
  // every render, or a manual Close is re-opened on the next tick.
  const autoOpenedConversationId = useRef<number | null>(null);

  useEffect(() => {
    if (openConversationId !== null) {
      setOpenedPendingPermission(pendingPermission);
      setOpen(true);
      setView({ kind: 'detail', conversationId: openConversationId });
      storeConversationId(localStorage, openConversationId);
      autoOpenedConversationId.current = openConversationId;
      onConversationOpened();
      return;
    }
    if (conversationId === null || conversationId === undefined) return;
    if (autoOpenedConversationId.current === conversationId) return;
    autoOpenedConversationId.current = conversationId;
    setOpenedPendingPermission((current) =>
      current?.conversationId === conversationId ? current : null,
    );
    setOpen(true);
    setView({ kind: 'detail', conversationId });
    storeConversationId(localStorage, conversationId);
  }, [conversationId, openConversationId, onConversationOpened, pendingPermission]);

  const [conversations, setConversations] = useState<Conversation[]>([]);

  const [attention, setAttention] = useState<AttentionState>(NO_ATTENTION);

  const upsertConversationInList = useCallback((c: Conversation) => {
    setConversations((current) => upsertConversation(current, c));
  }, []);
  const removeConversationFromList = useCallback((id: number) => {
    setConversations((current) => removeConversationById(current, id));
    setAttention((current) => clearAttention(current, id));
  }, []);

  const focusedRef = useRef<number | null>(null);
  useEffect(() => {
    focusedRef.current = open && view.kind === 'detail' ? view.conversationId : null;
  }, [open, view]);

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) setAttention((current) => clearAllAttention(current));
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (open && view.kind === 'detail' && view.conversationId !== null) {
      setAttention((current) => clearAttention(current, view.conversationId as number));
    }
  }, [open, view]);

  useEffect(() => {
    if (workspaceId === null) return;
    setConversations([]);
    const load = () =>
      api.conversations(workspaceId).then(({ conversations }) => setConversations(conversations), toastError);
    load();
    const unsubscribe = subscribe((msg) => {
      setAttention((current) => applyAttentionMessage(current, msg, focusedRef.current));
      if (msg.type === 'conversation_changed' && msg.conversation.workspaceId === workspaceId) {
        setConversations((current) => upsertConversation(current, msg.conversation));
      }
    }, load);
    return unsubscribe;
  }, [workspaceId]);

  const openList = () => {
    setView({ kind: 'list' });
    clearConversationId(localStorage);
  };
  const openConversation = (id: number) => {
    setView({ kind: 'detail', conversationId: id });
    storeConversationId(localStorage, id);
  };
  const openCompose = () => {
    setView({ kind: 'detail', conversationId: null });
    clearConversationId(localStorage);
  };

  const { conversation, events, pending, pendingElicitations, actions } = useConversationDetail(focusedId, {
    workspaceId,
    upsertConversationInList,
    removeConversationFromList,
    openConversation,
    openList,
    pendingPermission: openedPendingPermission,
    clearPendingPermission: clearOpenedPendingPermission,
  });

  if (!open) {
    const needsAttention = hasAttention(attention);
    return (
      <button
        aria-label={needsAttention ? 'Open conversation — needs attention' : 'Open conversation'}
        title="Conversation"
        onClick={() => setOpen(true)}
        className="absolute bottom-0 right-4 z-40 flex items-center gap-2 rounded-b-none rounded-t-lg bg-surface px-3.5 pb-2 pt-2.5 font-medium text-ink shadow-bar transition-colors duration-150 hover:bg-raised"
      >
        <span className="relative inline-flex">
          <Icon name="chat" className="text-accent" />
          {needsAttention && (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent ring-2 ring-surface"
            />
          )}
        </span>
        Conversation
      </button>
    );
  }

  const composerReady = view.kind === 'detail' && (view.conversationId === null || conversation !== null);
  const ended = conversation?.state === 'ended';

  return (
    <div
      role="dialog"
      aria-label="Conversation"
      data-dock={expanded ? 'expanded' : 'docked'}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      className={`z-40 flex flex-col rounded-lg bg-surface shadow-bar ${
        flourish ? 'motion-safe:animate-[dialog-in_150ms_var(--ease-out-quint)]' : ''
      } ${
        expanded
          ? 'fixed inset-6'
          : 'absolute inset-y-4 right-4 w-[26rem] max-w-[calc(100%-2rem)]'
      }`}
    >
      {view.kind === 'list' ? (
        <ConversationList
          conversations={conversations}
          attention={attention}
          expanded={expanded}
          onSelect={openConversation}
          onNew={openCompose}
          onDelete={actions.deleteConversation}
          onToggleExpand={toggleExpanded}
          onClose={() => setOpen(false)}
        />
      ) : (
        <>
          <ConversationHeader
            conversation={conversation}
            composing={view.conversationId === null}
            expanded={expanded}
            onBack={openList}
            onToggleExpand={toggleExpanded}
            onRename={actions.rename}
            onEnd={actions.end}
            onDelete={() => conversation && actions.deleteConversation(conversation.id)}
            onClose={() => setOpen(false)}
          />

          {conversation && <TelemetryStrip conversation={conversation} events={events} />}

          <div className="flex-1 overflow-y-auto p-4">
            <Transcript events={events} conversation={conversation} />
          </div>
          <StreamAnnouncer events={events} resetKey={conversation?.id ?? 'new'} />

          {!ended &&
            Object.values(pending).map((p) => (
              <PermissionPrompt
                key={p.reqId}
                pending={p}
                workingDir={conversation?.workingDir ?? ''}
                onAnswer={actions.answerPermission}
              />
            ))}

          {!ended &&
            Object.values(pendingElicitations).map((p) => (
              <ElicitationPrompt key={p.reqId} pending={p} onAnswer={actions.answerElicitation} />
            ))}

          {ended ? (
            <p role="status" className="border-t border-hairline bg-raised px-4 py-2.5 text-muted">
              This conversation has ended — read-only.
            </p>
          ) : (
            config &&
            composerReady && (
              <Composer
                config={config}
                workspace={workspace}
                conversation={conversation}
                events={events}
                expanded={expanded}
                onSend={actions.send}
              />
            )
          )}
        </>
      )}
    </div>
  );
}

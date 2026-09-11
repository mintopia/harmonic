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
import { PermissionRules } from './PermissionRules';
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
  sectionTitle,
  toolChip,
  touchTarget,
  touchTargetInline,
} from '../ui';

function PermissionModeToggle({
  mode,
  disabled,
  onChange,
}: {
  mode: Conversation['permissionMode'];
  disabled: boolean;
  onChange?: (mode: Conversation['permissionMode']) => void;
}) {
  const option = (value: Conversation['permissionMode'], label: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      disabled={disabled}
      className={`rounded-sm py-1.5 text-small font-semibold transition-colors duration-150 disabled:opacity-50 ${
        mode === value ? 'bg-accent text-on-accent shadow-btn' : 'text-muted hover:text-ink'
      }`}
      onClick={() => onChange?.(value)}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Permission mode" className="grid grid-cols-2 gap-1 rounded-md border border-edge bg-sunken p-1">
      {option('ask', 'Ask each turn')}
      {option('automatic', 'Automatic')}
    </div>
  );
}

export function ConversationContextDrawer({
  conversation,
  events,
  onClose,
  onPermissionModeChange,
  onEnd,
  onDelete,
}: {
  conversation: Conversation;
  events: ConversationEvent[];
  onClose: () => void;
  onPermissionModeChange?: (permissionMode: Conversation['permissionMode']) => void;
  onEnd?: () => void;
  onDelete?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, []);

  const tokenBreakdown = formatTokenBreakdown(conversation.usage);
  const totals = conversation.usage?.totals;
  const io = totals ? (totals.inputTokens + totals.outputTokens).toLocaleString() : null;
  const cost = formatCost(conversation.cost);
  const context = formatContextUsage(computeContextUsage(conversation));
  const contextFraction =
    conversation.contextWindow && conversation.contextTokens != null
      ? Math.min(1, Math.max(0, conversation.contextTokens / conversation.contextWindow))
      : null;
  const coldCache = formatColdCacheMessage({
    lastTurnAt: lastConversationTurnAt(events) ?? conversation.updatedAt,
    cacheWarmSeconds: conversation.cacheWarmSeconds,
    now,
  });
  const ended = conversation.state === 'ended';

  return (
    <aside aria-label="Conversation context" className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-hairline">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <h2 className={panelTitle}>Context</h2>
        <button type="button" className={btnQuiet} onClick={onClose} aria-label="Hide conversation context">
          Hide
        </button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <section aria-labelledby="conversation-usage-heading">
          <h3 id="conversation-usage-heading" className={sectionTitle}>Usage · this conversation</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="rounded-md border border-hairline bg-sunken px-3 py-2.5">
              <div className="font-data text-lg font-semibold tabular-nums text-ink">{io ?? '—'}</div>
              <div className="mt-1 text-label font-bold uppercase tracking-[0.08em] text-faint">I/O tokens</div>
            </div>
            <div className="rounded-md border border-hairline bg-sunken px-3 py-2.5">
              <div className="font-data text-lg font-semibold tabular-nums text-ink">{cost ?? '—'}</div>
              <div className="mt-1 text-label font-bold uppercase tracking-[0.08em] text-faint">Cost</div>
            </div>
          </div>
          {tokenBreakdown && (
            <dl className="mt-3">
              {tokenBreakdown.map(({ label, value }, index) => (
                <div
                  key={label}
                  className={`flex items-center justify-between py-1.5 text-small ${
                    index < tokenBreakdown.length - 1 ? 'border-b border-hairline' : ''
                  }`}
                >
                  <dt className="text-muted">{label}</dt>
                  <dd className="font-data tabular-nums text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="mt-3.5">
            <div className="flex items-baseline justify-between text-small text-muted">
              <span>Context window</span>
              <span className="font-data tabular-nums text-ink">{context.value}</span>
            </div>
            {contextFraction != null && (
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised">
                <div className="h-full rounded-full bg-accent" style={{ width: `${contextFraction * 100}%` }} />
              </div>
            )}
            {(coldCache || context.note) && (
              <p role="status" className="mt-2 text-small text-faint">{coldCache ?? context.note}</p>
            )}
          </div>
        </section>

        <section aria-labelledby="conversation-model-heading">
          <h3 id="conversation-model-heading" className={sectionTitle}>Model</h3>
          <dl className="mt-2">
            <div className="grid grid-cols-[5rem_1fr] items-center gap-3 border-b border-hairline py-2">
              <dt className="text-small text-faint">Harness</dt>
              <dd className="text-small text-ink">{providerLabel(conversation.harness)}</dd>
            </div>
            <div className="grid grid-cols-[5rem_1fr] items-center gap-3 border-b border-hairline py-2">
              <dt className="text-small text-faint">Model</dt>
              <dd className="font-data text-data text-muted">{conversation.model}</dd>
            </div>
            <div className="grid grid-cols-[5rem_1fr] items-center gap-3 py-2">
              <dt className="text-small text-faint">Directory</dt>
              <PathTail path={conversation.workingDir} className="min-w-0 font-data text-data text-muted" />
            </div>
          </dl>
        </section>

        <section aria-labelledby="conversation-permissions-heading">
          <h3 id="conversation-permissions-heading" className={sectionTitle}>Permissions</h3>
          <div className="mt-2">
            <PermissionModeToggle
              mode={conversation.permissionMode}
              disabled={ended}
              onChange={onPermissionModeChange}
            />
          </div>
          <p className="mt-2.5 text-small text-muted">
            {conversation.permissionMode === 'automatic'
              ? 'Automatic approves every tool call — edits, commands, everything — with no prompts.'
              : 'Ask each turn pauses on every tool call so you approve edits and commands as they come.'}
          </p>
          <div className="mt-3"><PermissionRules /></div>
        </section>
      </div>
      {(onEnd || onDelete) && (
        <div className="flex items-center gap-2 border-t border-hairline px-4 py-3">
          {onEnd && !ended && (
            <button type="button" className={btnQuiet} onClick={onEnd}>
              End conversation
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className={`ml-auto ${btnQuietDestructive}`}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </button>
          )}
        </div>
      )}
      {confirmingDelete && (
        <ConfirmDialog
          label="Delete conversation"
          title="Delete this conversation?"
          confirmLabel="Delete"
          tone="danger"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            onDelete?.();
          }}
        >
          This permanently deletes the conversation and its history. This cannot be undone.
        </ConfirmDialog>
      )}
    </aside>
  );
}

function ColdResumeWarning({ conversation }: { conversation: Conversation | null }) {
  if (!conversation?.coldResume) return null;
  return (
    <p role="status" className="border-t border-hairline bg-running-tint px-4 py-2.5 text-small text-muted">
      This conversation will resume from a cold session. Your next message may cost more.
    </p>
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

type ConversationHeaderProps = {
  conversation: Conversation | null;
  composing: boolean;
  onBack: () => void;
  onRename: (title: string | null) => Promise<void>;
  onEnd: () => void;
  onDelete: () => void;
} & (
  | { fullPage: true; onToggleContext: () => void; contextOpen: boolean }
  | { fullPage?: false; expanded: boolean; onToggleExpand: () => void; onClose: () => void }
);

function headerTelemetry(conversation: Conversation): string | null {
  const totals = conversation.usage?.totals;
  const io = totals ? totals.inputTokens + totals.outputTokens : null;
  const cost = formatCost(conversation.cost);
  const context = formatContextUsage(computeContextUsage(conversation));
  const parts = [
    io != null ? `${io.toLocaleString()} I/O` : null,
    cost,
    context.value ? `${context.value} context` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ') : null;
}

function ConversationHeader(props: ConversationHeaderProps) {
  const { conversation, composing, onBack, onRename, onEnd, onDelete } = props;
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
        {props.fullPage
          ? conversation && (
              <button
                aria-label="Toggle conversation context"
                aria-expanded={props.contextOpen}
                className={`${touchTargetInline} ${btnQuiet} ${props.contextOpen ? 'bg-raised text-ink' : ''}`}
                onClick={props.onToggleContext}
              >
                <Icon name="table" className="mr-1.5 size-3.5" />
                Context
              </button>
            )
          : (
            <>
              <button
                aria-label={props.expanded ? 'Collapse to panel' : 'Expand to full view'}
                className={`${touchTarget} ${btnQuiet}`}
                onClick={props.onToggleExpand}
              >
                <Icon name={props.expanded ? 'collapse' : 'expand'} />
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
              <button aria-label="Close conversation panel" className={`${touchTarget} ${btnQuiet}`} onClick={props.onClose}>
                <Icon name="close" />
              </button>
            </>
          )}
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
          {conversation.permissionMode === 'automatic' && <span className={toolChip}>Automatic</span>}
          <span aria-hidden="true" className="shrink-0 text-faint">
            ·
          </span>
          <PathTail path={conversation.workingDir} className="min-w-0 flex-1 truncate font-data" />
          {headerTelemetry(conversation) && (
            <span className="ml-auto shrink-0 whitespace-nowrap pl-3 font-data text-small tabular-nums text-faint">
              {headerTelemetry(conversation)}
            </span>
          )}
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

  const openList = useCallback(() => {
    setView({ kind: 'list' });
    clearConversationId(localStorage);
  }, []);
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

          <Transcript events={events} conversation={conversation} />
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
              <>
                <ColdResumeWarning conversation={conversation} />
                <Composer
                  config={config}
                  workspace={workspace}
                  conversation={conversation}
                  events={events}
                  expanded={expanded}
                  onSend={actions.send}
                />
              </>
            )
          )}
        </>
      )}
    </div>
  );
}

export function ConversationsPage({
  config,
  workspace,
  conversationId,
  onConversationChange,
}: {
  config: AppConfig | null;
  workspace: Workspace | null;
  conversationId: number | null;
  onConversationChange: (conversationId: number | null) => void;
}) {
  const workspaceId = workspace?.id ?? null;
  const [view, setView] = useState<LauncherView>(() =>
    conversationId === null ? { kind: 'list' } : { kind: 'detail', conversationId },
  );
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [attention, setAttention] = useState<AttentionState>(NO_ATTENTION);
  const [openedPendingPermission, setOpenedPendingPermission] = useState<PendingPermission | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const focusedId = view.kind === 'detail' ? view.conversationId : null;
  const focusedRef = useRef<number | null>(focusedId);

  useEffect(() => {
    focusedRef.current = focusedId;
    if (focusedId !== null) setAttention((current) => clearAttention(current, focusedId));
  }, [focusedId]);

  useEffect(() => {
    setView(conversationId === null ? { kind: 'list' } : { kind: 'detail', conversationId });
  }, [conversationId]);

  const upsertConversationInList = useCallback((conversation: Conversation) => {
    setConversations((current) => upsertConversation(current, conversation));
  }, []);
  const removeConversationFromList = useCallback((id: number) => {
    setConversations((current) => removeConversationById(current, id));
    setAttention((current) => clearAttention(current, id));
  }, []);

  useEffect(() => {
    if (workspaceId === null) return;
    setConversations([]);
    const load = () =>
      api.conversations(workspaceId).then(({ conversations }) => setConversations(conversations), toastError);
    load();
    return subscribe((message) => {
      setAttention((current) => applyAttentionMessage(current, message, focusedRef.current));
      if (message.type === 'conversation_changed' && message.conversation.workspaceId === workspaceId) {
        setConversations((current) => upsertConversation(current, message.conversation));
      }
    }, load);
  }, [workspaceId]);

  const openList = useCallback(() => {
    setView({ kind: 'list' });
    onConversationChange(null);
  }, [onConversationChange]);
  const openConversation = (id: number) => {
    setView({ kind: 'detail', conversationId: id });
    onConversationChange(id);
  };
  const openCompose = () => {
    setView({ kind: 'detail', conversationId: null });
    onConversationChange(null);
  };
  const clearPendingPermission = useCallback(() => setOpenedPendingPermission(null), []);
  const { conversation, events, pending, pendingElicitations, actions } = useConversationDetail(focusedId, {
    workspaceId,
    upsertConversationInList,
    removeConversationFromList,
    openConversation,
    openList,
    pendingPermission: openedPendingPermission,
    clearPendingPermission,
  });
  const composerReady = view.kind === 'detail' && (view.conversationId === null || conversation !== null);
  const ended = conversation?.state === 'ended';
  const deleteConversation = (id: number) => {
    actions.deleteConversation(id);
    if (id === focusedId) openList();
  };

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-surface">
      <aside aria-label="Conversations" className="flex w-80 shrink-0 border-r border-hairline">
        <ConversationList
          conversations={conversations}
          attention={attention}
          selectedId={focusedId}
          fullPage
          onSelect={openConversation}
          onNew={openCompose}
          onDelete={deleteConversation}
        />
      </aside>
      <section aria-label="Conversation transcript" className="flex min-w-0 flex-1 flex-col">
        {view.kind === 'list' ? (
          <div className="flex flex-1 items-center justify-center px-6 text-muted">
            Select a conversation or start a new one.
          </div>
        ) : (
          <>
            <ConversationHeader
              conversation={conversation}
              composing={view.conversationId === null}
              fullPage
              contextOpen={contextOpen}
              onToggleContext={() => setContextOpen((open) => !open)}
              onBack={openList}
              onRename={actions.rename}
              onEnd={actions.end}
              onDelete={() => conversation && deleteConversation(conversation.id)}
            />
            <Transcript events={events} conversation={conversation} />
            <StreamAnnouncer events={events} resetKey={conversation?.id ?? 'new'} />
            {!ended &&
              Object.values(pending).map((pendingPermission) => (
                <PermissionPrompt
                  key={pendingPermission.reqId}
                  pending={pendingPermission}
                  workingDir={conversation?.workingDir ?? ''}
                  onAnswer={actions.answerPermission}
                />
              ))}
            {!ended &&
              Object.values(pendingElicitations).map((elicitation) => (
                <ElicitationPrompt key={elicitation.reqId} pending={elicitation} onAnswer={actions.answerElicitation} />
              ))}
            {ended ? (
              <p role="status" className="border-t border-hairline bg-raised px-4 py-2.5 text-muted">
                This conversation has ended — read-only.
              </p>
            ) : (
              config &&
              composerReady && (
                <>
                  <ColdResumeWarning conversation={conversation} />
                  <Composer
                    config={config}
                    workspace={workspace}
                    conversation={conversation}
                    events={events}
                    expanded={true}
                    onSend={actions.send}
                  />
                </>
              )
            )}
          </>
        )}
      </section>
      {view.kind === 'detail' && conversation && contextOpen && (
        <ConversationContextDrawer
          conversation={conversation}
          events={events}
          onClose={() => setContextOpen(false)}
          onPermissionModeChange={actions.setPermissionMode}
          onEnd={actions.end}
          onDelete={() => deleteConversation(conversation.id)}
        />
      )}
    </div>
  );
}

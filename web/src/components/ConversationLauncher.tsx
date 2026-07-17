import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';
import { subscribe } from '../ws';
import type { AppConfig, Conversation, ConversationEvent } from '../types';
import { segmentTranscript } from '../conversation-transcript-model';
import { isTurnRunning } from '../conversation-steering-model';
import {
  addPendingPermission,
  chooseAlwaysAllowOptionId,
  permissionOptionLabel,
  removePendingPermission,
  resolvePendingPermissionFromEvent,
  type PendingPermission,
  type PendingPermissions,
} from '../conversation-permissions-model';
import { clearConversationId, loadConversationId, storeConversationId } from '../conversation-storage';
import {
  computeContextUsage,
  formatColdCacheMessage,
  formatContextUsage,
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
import { ConversationList } from './ConversationList';
import { EventStream } from './EventStream';
import { ModelCombobox } from './ModelCombobox';
import { PathTail } from './PathTail';
import { Icon } from './Icon';
import { toastError } from '../toast';
import {
  btnPrimary,
  btnQuiet,
  btnQuietDestructive,
  field,
  panelTitle,
  labelType,
  permissionOptionButtonClass,
  toolChip,
} from '../ui';

/**
 * Live operator telemetry (issue #12): running tokens, estimated cost
 * (`formatCost` reused verbatim, so the ≥/unpriced honesty already built for
 * Stats/Task carries over unchanged), and context-window fill, plus an idle
 * cold-cache estimate. Every cell degrades honestly on missing data — no
 * fake zero token count, no fake context percentage — rather than hiding
 * the whole strip; only the cold-cache line disappears entirely, since an
 * unconfigured TTL isn't evidence of anything.
 *
 * The cold-cache read is genuinely time-dependent (idle time keeps growing
 * with no new Turn, unlike every other field here which only changes on a
 * `conversation_changed` message), so this re-evaluates its own predicate
 * on a 20s interval rather than only when `conversation` itself changes.
 * Shown for ended Conversations too (issue #15: read-only still means the
 * telemetry is visible, just frozen at its last value).
 */
function TelemetryStrip({ conversation, events }: { conversation: Conversation; events: ConversationEvent[] }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, []);

  const tokens = formatTokens(conversation.usage);
  const cost = formatCost(conversation.cost);
  const context = formatContextUsage(computeContextUsage(conversation));
  // The cold-cache clock runs from the last Turn, not the Conversation's
  // updatedAt (which a rename bumps without refreshing any cache).
  const coldCache = formatColdCacheMessage({
    lastTurnAt: lastConversationTurnAt(events) ?? conversation.updatedAt,
    cacheTtlSeconds: conversation.cacheTtlSeconds,
    now,
  });

  return (
    <div className="border-b border-hairline">
      {/* Live telemetry is ONE quiet status line, not a feature (DESIGN.md §
          Conversation): tokens · cost · context, whispered in Small muted
          sans. These are figures, so sans with tabular-nums — never the code
          face. Each part degrades honestly (no fake zero / no fake %). */}
      <p className="px-4 py-2 text-small text-muted">
        {tokens === 'no usage yet' ? 'no usage yet' : `${tokens} tokens`}
        {' · '}
        {cost ?? '—'}
        {' · '}
        {context.value === '—' ? '—' : `${context.value} context`}
        {context.note ? ` · ${context.note}` : ''}
      </p>
      {/* Quiet and neutral, not a state chip: Running Amber's meaning is
          locked to "work in flight" (DESIGN.md), and a cold cache is the
          opposite — idle time with no Turn — so this stays in the
          Raised/Muted informational register rather than borrowing a colour
          that would misstate what's happening. */}
      {coldCache && (
        <p role="status" className="bg-raised px-4 py-1.5 text-small text-muted">
          {coldCache}
        </p>
      )}
    </div>
  );
}

const fieldLabel = `mb-1 block ${labelType} text-muted`;

/** Segments the transcript on user_turn boundaries (event-stream-model.ts's
 * EventStream renders each turn's agent events unchanged) and keeps the
 * latest turn in view as the reply streams in. */
function Transcript({ events }: { events: ConversationEvent[] }) {
  const turns = segmentTranscript(events);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);

  if (turns.length === 0) {
    return <p className="text-muted">Send a message to begin.</p>;
  }

  return (
    <div className="space-y-4">
      {turns.map((turn, i) => (
        <div key={turn.userTurn?.id ?? `pre-${i}`}>
          {turn.userTurn && (
            <div className="mb-1.5 flex justify-end">
              {/* Operator prose — sans, never the code face (the Mono Is Code Rule). */}
              <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-accent-tint px-3 py-2 text-ink">
                {turn.userTurn.payload.text}
              </p>
            </div>
          )}
          {turn.agentEvents.length > 0 && <EventStream events={turn.agentEvents} />}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

/**
 * One outstanding ACP permission request (issue #11): the Harness is
 * genuinely blocked on the operator's decision, so this renders prominently
 * — its own banded section between the transcript and composer, always in
 * view (not scrolled away with the turn that raised it) — with an explicit
 * "waiting for your decision" line so the paused Turn is unmistakable.
 * Buttons render exactly the options the ACP request offers, plus one
 * synthesized "Always allow {kind} in {dir}" choice (issue #13 / ADR-0007):
 * that's a persistent auto-approval escalation, not a native ACP option, so
 * it renders last, in the quiet button treatment (never the tinted
 * allow-once pill or the tool-teal ghost allow-always uses) — it must never
 * read as the default click.
 */
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
    <div role="group" aria-label={`Permission request: ${title}`} className="border-t border-hairline bg-raised px-4 py-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={toolChip}>permission</span>
        <span className="font-medium text-ink">{title}</span>
      </div>
      <p className="mb-2.5 text-muted">Waiting for your decision — this turn is paused until you respond.</p>
      <div className="flex flex-wrap items-center gap-2">
        {pending.request.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            disabled={busyKey !== null}
            className={permissionOptionButtonClass(option.kind)}
            onClick={() => choose(option.optionId, option.optionId)}
          >
            {permissionOptionLabel(option.kind)}
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

function Composer({
  config,
  conversation,
  events,
  expanded,
  onSend,
}: {
  config: AppConfig;
  conversation: Conversation | null;
  events: ConversationEvent[];
  expanded: boolean;
  onSend: (
    fields: { harness: string; model: string; workingDir: string },
    text: string,
  ) => Promise<{ queued: boolean }>;
}) {
  // Defaulted from config exactly like TaskForm — only meaningful before a
  // conversation exists; once spawned the process's harness/model/workingDir
  // are read from the conversation itself and can no longer change.
  const [harness, setHarness] = useState(config.defaults.harness);
  const [model, setModel] = useState(config.harnesses[config.defaults.harness]?.defaultModel ?? '');
  const [workingDir, setWorkingDir] = useState(config.defaults.workingDir);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  // A transient, honest "this landed in the queue, not on the wire yet"
  // notice (issue #14) — cleared on a timer, like Toaster's own auto-dismiss,
  // rather than left to linger once the queued Turn has long since started.
  const [queued, setQueued] = useState(false);
  const queuedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (queuedTimer.current) clearTimeout(queuedTimer.current);
  }, []);

  const locked = conversation !== null;
  const ended = conversation?.state === 'ended';
  // Whether the panel offers Interrupt at all (issue #14): only meaningful
  // once a Turn can be running, i.e. an active, already-spawned conversation.
  const running = conversation?.state === 'active' && isTurnRunning(events);
  const models = config.harnesses[harness]?.models ?? [];

  const pickHarness = (h: string) => {
    setHarness(h);
    const cfg = config.harnesses[h];
    if (cfg) setModel(cfg.defaultModel);
  };

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy || ended) return;
    setBusy(true);
    try {
      const result = await onSend({ harness, model, workingDir }, trimmed);
      setText('');
      if (result.queued) {
        setQueued(true);
        if (queuedTimer.current) clearTimeout(queuedTimer.current);
        queuedTimer.current = setTimeout(() => setQueued(false), 4000);
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  // Cancels the in-flight Turn (ACP session/cancel): whatever is still
  // typed re-prompts as the next Turn, or — composer empty — this just
  // stops it. Either way the transcript, not this control, is what tells
  // the honest story afterwards (a `cancelled` stop reason, then a fresh
  // Turn if there was text to send).
  const interrupt = async () => {
    if (!conversation || interrupting) return;
    setInterrupting(true);
    try {
      const trimmed = text.trim();
      await api.interrupt(conversation.id, trimmed || undefined);
      setText('');
      setQueued(false);
    } catch (e) {
      toastError(e);
    } finally {
      setInterrupting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-hairline p-3">
      {!locked && (
        // Three across only when the panel is expanded; in the narrow dock
        // they stack, so the Working Directory path input isn't crushed to
        // ~120px (the grid keys off panel state, not viewport width).
        <div className={`mb-2 grid gap-2 ${expanded ? 'sm:grid-cols-3' : ''}`}>
          <div>
            <label className={fieldLabel} htmlFor="conv-harness">
              Harness
            </label>
            <select
              id="conv-harness"
              className={field}
              value={harness}
              onChange={(e) => pickHarness(e.target.value)}
            >
              {Object.keys(config.harnesses).map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={fieldLabel} htmlFor="conv-model">
              Model
            </label>
            <ModelCombobox id="conv-model" value={model} onChange={setModel} options={models} />
          </div>
          <div>
            <label className={fieldLabel} htmlFor="conv-workdir">
              Working Directory
            </label>
            <input
              id="conv-workdir"
              className={`${field} font-data`}
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
            />
          </div>
        </div>
      )}
      {/* Transient and honest (issue #14): this message really did land in
          the queue rather than start immediately — it clears itself once
          that's stopped being new information, same register as the
          cold-cache status line above (motion-safe-gated like Toaster's). */}
      {queued && (
        <p role="status" className="mb-1.5 text-label text-muted motion-safe:animate-[toast-in_150ms_var(--ease-out-quint)]">
          Queued — will send once the current turn finishes.
        </p>
      )}
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Message"
          className={`${field} min-h-16 flex-1 resize-none`}
          value={text}
          disabled={ended}
          placeholder={
            ended
              ? 'Conversation ended.'
              : running
                ? 'Message the agent… (Enter queues it for after this turn)'
                : 'Message the agent… (Enter to send, Shift+Enter for a newline)'
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {running && (
          <button
            type="button"
            className={`${btnQuietDestructive} px-1 pb-2.5`}
            disabled={interrupting}
            onClick={interrupt}
          >
            {text.trim() ? 'Interrupt' : 'Stop'}
          </button>
        )}
        <button aria-label="Send" className={btnPrimary} disabled={busy || ended || !text.trim()} onClick={send}>
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}

/**
 * The detail header (issue #15): back-to-list, the Conversation's title
 * (inline-editable — the rename affordance is available for any real
 * Conversation, ended ones included, since renaming is metadata, not a
 * Turn), the expand/collapse toggle, End (active only), Delete (quiet
 * destructive, per DESIGN.md — no confirm gate, matching Channels.tsx's own
 * delete), and Close. A second, Data-role line carries the id/state/
 * harness/model/Working Directory that used to sit in the composer's locked
 * banner — now shown here so it survives even when the composer itself
 * doesn't render (an ended Conversation has none at all).
 */
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
        <button aria-label="Back to conversations" className={btnQuiet} onClick={onBack}>
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
            <button aria-label="Save title" className={btnQuiet} disabled={saving} onClick={save}>
              <Icon name="check" />
            </button>
            <button aria-label="Cancel rename" className={btnQuiet} disabled={saving} onClick={() => setEditing(false)}>
              <Icon name="close" />
            </button>
          </>
        ) : (
          <>
            <span className={`${panelTitle} min-w-0 flex-1 truncate`}>{title}</span>
            {conversation && (
              <button aria-label="Rename conversation" className={btnQuiet} onClick={startEdit}>
                <Icon name="edit" />
              </button>
            )}
          </>
        )}
        <button
          aria-label={expanded ? 'Collapse to panel' : 'Expand to full view'}
          className={btnQuiet}
          onClick={onToggleExpand}
        >
          <Icon name={expanded ? 'collapse' : 'expand'} />
        </button>
        {conversation?.state === 'active' && (
          <button className={btnQuiet} onClick={onEnd}>
            End
          </button>
        )}
        {conversation && (
          <button className={btnQuietDestructive} onClick={onDelete}>
            Delete
          </button>
        )}
        <button aria-label="Close conversation panel" className={btnQuiet} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {conversation && (
        <div className="mt-1 flex items-center gap-1.5 text-small text-muted">
          {/* State as a small dot, not a full pill (DESIGN.md § Conversation:
              "a small 'Active' dot") — active is the quiet norm; an ended
              conversation is spelled out by the read-only banner and the
              disabled composer below, so it never needs a loud chip here.
              Neutral, per the lifecycle-not-work-state reasoning in ui.ts. */}
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              conversation.state === 'active' ? 'bg-muted' : 'bg-faint'
            }`}
            title={conversation.state}
          />
          <span className="sr-only">{conversation.state}</span>
          {/* Names read as language → sans (the Mono Is Code Rule). */}
          <span className="shrink-0">
            {conversation.harness} · {conversation.model}
          </span>
          <span aria-hidden="true" className="shrink-0 text-faint">
            ·
          </span>
          {/* Only the path is code (mono); it takes the remaining width and
              keeps its final segment whole, full path on hover. */}
          <PathTail path={conversation.workingDir} className="flex-1 font-data" />
        </div>
      )}
    </div>
  );
}

/** Which pane the open panel shows: the history list, or one Conversation's
 * detail — `conversationId: null` inside `detail` is the not-yet-created
 * "compose a new one" state the old walking skeleton always started in. */
type LauncherView = { kind: 'list' } | { kind: 'detail'; conversationId: number | null };

/**
 * The Conversations launcher (issue #10 walking skeleton; issue #15 grows it
 * into history browsing): a right-hand dock running the full height of the
 * working view. App mounts it inside the below-header region but outside the
 * view switch, so it is view-independent — its always-on firehose
 * subscription (attention tracking + a live list) keeps running whether the
 * panel is open or not, on every view. That region is also its positioning
 * context: the dock is `absolute` within it and so clears the header without
 * hardcoding the header's height (which moves — see App.tsx).
 *
 * The closed launcher sits flush on the bottom edge as a drawer tab, reading
 * as the pull for the panel that rises from it. The open dock does contend
 * with the toast stack for the top-right corner, and the stack yields: it
 * dodges left of a docked panel, keyed off the `data-dock` attribute below
 * (see toast.tsx). This file publishes that attribute and knows nothing else
 * about toasts.
 *
 * The last-viewed Conversation persists in localStorage (`conversation-
 * storage.ts`) so reopening the panel returns to it instead of the list —
 * explicitly leaving the list (the back arrow) forgets it, so *that* choice
 * also survives a close/reopen. A persisted Conversation that comes back
 * `ended` (e.g. after a server restart orphaned it) still opens straight to
 * its detail — just read-only, never a fake resume.
 */
export function ConversationLauncher({ config }: { config: AppConfig | null }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // A one-shot flag that adds the entrance-flourish class for ~150ms after
  // toggling expand/collapse, then removes it — re-adding the same class
  // later still restarts the CSS animation (it only replays on a genuine
  // "gained the class" transition), so this never needs a remount, which
  // would otherwise blow away in-progress Composer text on every toggle.
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

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  // Prompts the Harness is genuinely blocked on (issue #11), scoped to
  // whichever conversation is open.
  const [pending, setPending] = useState<PendingPermissions>({});

  // Needs-attention tracking (issue #15): which Conversations, keyed by id,
  // saw a permission request or a finished Turn land while the operator
  // wasn't looking at them. `focusedRef` mirrors `open`/`view` into a ref so
  // the always-on subscription below never needs to reconnect just because
  // the operator switched panes.
  const [attention, setAttention] = useState<AttentionState>(NO_ATTENTION);
  const focusedRef = useRef<number | null>(null);
  useEffect(() => {
    focusedRef.current = open && view.kind === 'detail' ? view.conversationId : null;
  }, [open, view]);

  // Clears the whole badge on the collapsed → open transition (the LOCKED
  // contract's first clearing trigger).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) setAttention((current) => clearAllAttention(current));
    wasOpenRef.current = open;
  }, [open]);

  // Clears one Conversation's entry the moment the operator views it (the
  // LOCKED contract's other trigger) — covers switching between
  // Conversations without closing the panel in between.
  useEffect(() => {
    if (open && view.kind === 'detail' && view.conversationId !== null) {
      setAttention((current) => clearAttention(current, view.conversationId as number));
    }
  }, [open, view]);

  // The always-on firehose subscription (issue #15): mounted for the
  // launcher's whole lifetime, independent of `open`/`view`, so a
  // permission request or finished Turn on a background Conversation is
  // caught even while the panel is collapsed. Doubles as the list's live
  // feed, so a title/usage/state change is reflected in the history list
  // whether or not it's currently on screen.
  useEffect(() => {
    api.conversations().then(({ conversations }) => setConversations(conversations), toastError);
    const unsubscribe = subscribe((msg) => {
      setAttention((current) => applyAttentionMessage(current, msg, focusedRef.current));
      if (msg.type === 'conversation_changed') {
        setConversations((current) => upsertConversation(current, msg.conversation));
      }
    });
    return unsubscribe;
  }, []);

  // The focused Conversation's own detail stream (issues #10–#14, largely
  // unchanged): replay the persisted events, then append live ones as they
  // arrive, deduped by id. Runs whenever `focusedId` changes — including to
  // null, which just clears the detail state (the list, or a fresh compose,
  // show nothing here).
  useEffect(() => {
    if (focusedId === null) {
      setConversation(null);
      setEvents([]);
      setPending({});
      return;
    }
    const id = focusedId;
    let live = true;
    // Clear the previous Conversation's state before replaying this one
    // (TaskDetail.tsx's run-switch pattern), so switching in the list never
    // flashes stale transcript/telemetry under the new id.
    setConversation(null);
    setEvents([]);
    setPending({});
    api.conversation(id).then((c) => {
      if (!live) return;
      setConversation(c);
      setConversations((current) => upsertConversation(current, c));
    }, toastError);
    api.conversationEvents(id).then(({ events }) => live && setEvents(events), toastError);
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'conversation_event' && msg.event.conversationId === id) {
        setEvents((current) =>
          current.some((e) => e.id === msg.event.id) ? current : [...current, msg.event],
        );
        // The resolution signal (LOCKED contract): a permission_request
        // conversation_event whose payload.reqId matches a pending prompt
        // clears it, whether it was answered here or elsewhere/crashed.
        setPending((current) => resolvePendingPermissionFromEvent(current, msg.event));
      }
      if (msg.type === 'permission_request' && msg.conversationId === id) {
        setPending((current) => addPendingPermission(current, msg));
      }
      if (msg.type === 'conversation_changed' && msg.conversation.id === id) {
        setConversation(msg.conversation);
        setConversations((current) => upsertConversation(current, msg.conversation));
        // Belt-and-braces: the server auto-clears pending permissions on
        // end/crash via the resolution signal above, but a prompt should
        // never outlive the conversation's own 'ended' state in the UI.
        if (msg.conversation.state === 'ended') setPending({});
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [focusedId]);

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

  const send = async (fields: { harness: string; model: string; workingDir: string }, text: string) => {
    let id = view.kind === 'detail' ? view.conversationId : null;
    if (id === null) {
      // First turn: spawns the harness server-side once this and the
      // turn below land — harness/model/workingDir lock from here on.
      const created = await api.createConversation(fields);
      id = created.id;
      setConversations((current) => upsertConversation(current, created));
      setConversation(created);
      setView({ kind: 'detail', conversationId: id });
      storeConversationId(localStorage, id);
    }
    const { queued } = await api.sendTurn(id, text);
    return { queued };
  };

  const end = () => {
    const id = view.kind === 'detail' ? view.conversationId : null;
    if (id === null) return;
    api.endConversation(id).then((c) => {
      setConversation(c);
      setConversations((current) => upsertConversation(current, c));
      setPending({});
    }, toastError);
  };

  const rename = async (title: string | null) => {
    const id = view.kind === 'detail' ? view.conversationId : null;
    if (id === null) return;
    try {
      const updated = await api.renameConversation(id, title);
      setConversation(updated);
      setConversations((current) => upsertConversation(current, updated));
    } catch (e) {
      toastError(e);
    }
  };

  const deleteConversation = async (id: number) => {
    try {
      await api.deleteConversation(id);
      setConversations((current) => removeConversationById(current, id));
      setAttention((current) => clearAttention(current, id));
      if (view.kind === 'detail' && view.conversationId === id) openList();
    } catch (e) {
      toastError(e);
    }
  };

  // Optimistic relative to the *resolving event*, not the HTTP response:
  // the server confirms via a conversation_event carrying this reqId, but
  // there is no reason to wait for it once the answer POST itself
  // succeeded — remove the prompt immediately, and re-add it (implicitly,
  // by leaving state untouched) on failure so the operator can retry.
  const answerPermission = async (p: PendingPermission, optionId: string, remember?: boolean) => {
    try {
      await api.answerPermission(p.conversationId, p.reqId, optionId, remember);
      setPending((current) => removePendingPermission(current, p.reqId));
    } catch (e) {
      toastError(e);
    }
  };

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
          {/* The needs-attention dot: TaskDetail's tab-flag treatment
              (a small accent dot, aria-hidden — the aria-label above carries
              the same information to assistive tech), not a state color;
              see conversation-attention-model.ts's header comment. */}
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

  // While the focused conversation is still loading, hold off on the
  // composer rather than flash the unlocked (harness/model/workingDir
  // editable) form before the locked, server-confirmed one replaces it.
  const composerReady = view.kind === 'detail' && (view.conversationId === null || conversation !== null);
  const ended = conversation?.state === 'ended';

  return (
    <div
      role="dialog"
      aria-label="Conversation"
      // Layout-only signal, read by the toast stack via `group-has-` so it can
      // dodge a docked panel without this component publishing its open state
      // (see toast.tsx). Expanded is deliberately a different value: it is a
      // viewport overlay with no free corner to dodge into.
      data-dock={expanded ? 'expanded' : 'docked'}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      className={`z-40 flex flex-col rounded-lg bg-surface shadow-bar ${
        flourish ? 'motion-safe:animate-[dialog-in_150ms_var(--ease-out-quint)]' : ''
      } ${
        // Docked: absolute within App's below-header region, so the panel
        // runs the full height of the working view without ever needing to
        // know where the header ends. Expanded stays `fixed`: it is a
        // viewport overlay and covers the header by design.
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
          onDelete={deleteConversation}
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
            onRename={rename}
            onEnd={end}
            onDelete={() => conversation && deleteConversation(conversation.id)}
            onClose={() => setOpen(false)}
          />

          {conversation && <TelemetryStrip conversation={conversation} events={events} />}

          <div className="flex-1 overflow-y-auto p-4">
            <Transcript events={events} />
          </div>

          {/* Pending prompts sit outside the scrollable transcript so a
              paused Turn stays visible without hunting for it — the panel
              is non-modal, so this never traps focus. Ended Conversations
              never carry one (issue #15: read-only means no permission
              prompts at all, belt-and-braces alongside `pending` already
              being empty for them). */}
          {!ended &&
            Object.values(pending).map((p) => (
              <PermissionPrompt
                key={p.reqId}
                pending={p}
                workingDir={conversation?.workingDir ?? ''}
                onAnswer={answerPermission}
              />
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
                conversation={conversation}
                events={events}
                expanded={expanded}
                onSend={send}
              />
            )
          )}
        </>
      )}
    </div>
  );
}

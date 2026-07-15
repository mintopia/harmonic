import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';
import { subscribe } from '../ws';
import type { AppConfig, Conversation, ConversationEvent } from '../types';
import { segmentTranscript } from '../conversation-transcript-model';
import {
  addPendingPermission,
  chooseAlwaysAllowOptionId,
  permissionOptionLabel,
  removePendingPermission,
  resolvePendingPermissionFromEvent,
  type PendingPermission,
  type PendingPermissions,
} from '../conversation-permissions-model';
import { loadConversationId, storeConversationId } from '../conversation-storage';
import {
  computeContextUsage,
  formatColdCacheMessage,
  formatContextUsage,
  formatTokens,
} from '../conversation-telemetry-model';
import { formatCost } from '../cost';
import { EventStream } from './EventStream';
import { ModelCombobox } from './ModelCombobox';
import { Icon } from './Icon';
import { toastError } from '../toast';
import { btnPrimary, btnQuiet, field, headline, labelType, permissionOptionButtonClass, toolChip } from '../ui';

/** One cell of the telemetry strip: muted label over a Data-role value —
 * the same "label over figure" shape StatsPage's summary card uses, just at
 * strip density rather than hero size (this is a live status readout, not
 * the Stats view's headline number). */
function TelemetryCell({
  label,
  value,
  note,
  muted,
}: {
  label: string;
  value: string;
  note?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex-1 px-3 py-2">
      <div className={`${labelType} text-muted`}>{label}</div>
      <div className={`font-data text-data font-semibold ${muted ? 'text-faint' : 'text-ink'}`}>{value}</div>
      {note && <div className="text-label text-faint">{note}</div>}
    </div>
  );
}

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
 */
function TelemetryStrip({ conversation }: { conversation: Conversation }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, []);

  const tokens = formatTokens(conversation.usage);
  const cost = formatCost(conversation.cost);
  const context = formatContextUsage(computeContextUsage(conversation));
  const coldCache = formatColdCacheMessage({
    updatedAt: conversation.updatedAt,
    cacheTtlSeconds: conversation.cacheTtlSeconds,
    now,
  });

  return (
    <div className="border-b border-hairline">
      <div className="flex divide-x divide-hairline">
        <TelemetryCell label="Tokens" value={tokens} muted={tokens === 'no usage yet'} />
        <TelemetryCell label="Cost" value={cost ?? '—'} muted={cost === null} />
        <TelemetryCell
          label="Context"
          value={context.value}
          note={context.note ?? undefined}
          muted={context.value === '—'}
        />
      </div>
      {/* Quiet and neutral, not a state chip: Running Amber's meaning is
          locked to "work in flight" (DESIGN.md), and a cold cache is the
          opposite — idle time with no Turn — so this stays in the
          Raised/Muted informational register (the same one toasts' inline
          counterpart and the permission-prompt copy use) rather than
          borrowing a color that would misstate what's happening. */}
      {coldCache && (
        <p role="status" className="bg-raised px-4 py-1.5 text-muted">
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
              {/* Operator prose — Body face, never Data (the Mono Is Data Rule). */}
              <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-raised px-3 py-2 text-ink">
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
            <span className="inline-block max-w-[10rem] truncate align-bottom font-data text-data">{workingDir}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function Composer({
  config,
  conversation,
  onSend,
}: {
  config: AppConfig;
  conversation: Conversation | null;
  onSend: (fields: { harness: string; model: string; workingDir: string }, text: string) => Promise<void>;
}) {
  // Defaulted from config exactly like TaskForm — only meaningful before a
  // conversation exists; once spawned the process's harness/model/workingDir
  // are read from the conversation itself and can no longer change.
  const [harness, setHarness] = useState(config.defaults.harness);
  const [model, setModel] = useState(config.harnesses[config.defaults.harness]?.defaultModel ?? '');
  const [workingDir, setWorkingDir] = useState(config.defaults.workingDir);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const locked = conversation !== null;
  const ended = conversation?.state === 'ended';
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
      await onSend({ harness, model, workingDir }, trimmed);
      setText('');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
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
      {locked ? (
        <p className="mb-2 font-data text-data text-muted">
          {conversation.harness} · {conversation.model} · {conversation.workingDir}
        </p>
      ) : (
        <div className="mb-2 grid gap-2 sm:grid-cols-3">
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
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Message"
          className={`${field} min-h-16 flex-1 resize-none`}
          value={text}
          disabled={ended}
          placeholder={ended ? 'Conversation ended.' : 'Message the agent… (Enter to send, Shift+Enter for a newline)'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button aria-label="Send" className={btnPrimary} disabled={busy || ended || !text.trim()} onClick={send}>
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}

/**
 * The Conversations launcher (issue #10 walking skeleton): a bottom-right
 * docked panel, sibling to the Toaster — mounted view-independently at the
 * end of App's return. Docked higher than the Toaster's `bottom-4 right-4
 * z-50` (and one z-layer under it) so a failure toast never collides with
 * an open panel. The active conversation id persists in localStorage so
 * closing/reopening the panel replays it instead of ending it; only the
 * explicit End control (`POST .../end`) does that.
 */
export function ConversationLauncher({ config }: { config: AppConfig | null }) {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(() => loadConversationId(localStorage));
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  // Prompts the Harness is genuinely blocked on (issue #11), scoped to
  // whichever conversation is open — see the effect below for how entries
  // are added (a `permission_request` WS message) and cleared (its
  // resolving `conversation_event`, or the conversation ending).
  const [pending, setPending] = useState<PendingPermissions>({});

  useEffect(() => {
    if (conversationId === null) return;
    let live = true;
    // A freshly opened/switched conversation starts with no known-pending
    // prompts — the only source of a pending prompt is the live WS message
    // below, there is no REST endpoint to recover one still outstanding
    // server-side across a reload (it lands as a resolved conversation_event
    // once answered either way).
    setPending({});
    api.conversation(conversationId).then((c) => live && setConversation(c), toastError);
    // Replay the persisted stream, then append live events as they arrive —
    // one representation for both (TaskDetail.tsx's pattern), deduped by id.
    api.conversationEvents(conversationId).then(({ events }) => live && setEvents(events), toastError);
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'conversation_event' && msg.event.conversationId === conversationId) {
        setEvents((current) =>
          current.some((e) => e.id === msg.event.id) ? current : [...current, msg.event],
        );
        // The resolution signal (LOCKED contract): a permission_request
        // conversation_event whose payload.reqId matches a pending prompt
        // clears it, whether it was answered here or elsewhere/crashed.
        setPending((current) => resolvePendingPermissionFromEvent(current, msg.event));
      }
      if (msg.type === 'permission_request' && msg.conversationId === conversationId) {
        setPending((current) => addPendingPermission(current, msg));
      }
      if (msg.type === 'conversation_changed' && msg.conversation.id === conversationId) {
        setConversation(msg.conversation);
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
  }, [conversationId]);

  const send = async (fields: { harness: string; model: string; workingDir: string }, text: string) => {
    let id = conversationId;
    if (id === null) {
      // First turn: spawns the harness server-side once this and the
      // turn below land — harness/model/workingDir lock from here on.
      const created = await api.createConversation(fields);
      id = created.id;
      storeConversationId(localStorage, id);
      setConversation(created);
      setConversationId(id);
    }
    await api.sendTurn(id, text);
  };

  const end = () => {
    if (conversationId === null) return;
    api.endConversation(conversationId).then((c) => {
      setConversation(c);
      setPending({});
    }, toastError);
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
    return (
      <button
        aria-label="Open conversation"
        title="Conversation"
        onClick={() => setOpen(true)}
        className="fixed bottom-24 right-4 z-40 flex items-center gap-2 rounded-lg bg-surface px-3.5 py-2.5 font-medium text-ink shadow-bar transition-colors duration-150 hover:bg-raised"
      >
        <Icon name="chat" className="text-accent" />
        Conversation
      </button>
    );
  }

  // While a persisted conversation id is loading, hold off on the composer
  // rather than flash the unlocked (harness/model/workingDir editable) form
  // before the locked, server-confirmed one replaces it.
  const composerReady = conversationId === null || conversation !== null;

  return (
    <div
      role="dialog"
      aria-label="Conversation"
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      className="fixed bottom-24 right-4 z-40 flex h-[32rem] w-[26rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg bg-surface shadow-bar"
    >
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
        <span className={headline}>Conversation</span>
        {conversation && (
          <span className="font-data text-data text-muted">
            #{conversation.id} · {conversation.state}
          </span>
        )}
        <div className="flex-1" />
        {conversation?.state === 'active' && (
          <button className={btnQuiet} onClick={end}>
            End
          </button>
        )}
        <button aria-label="Close conversation panel" className={btnQuiet} onClick={() => setOpen(false)}>
          <Icon name="close" />
        </button>
      </div>

      {conversation && <TelemetryStrip conversation={conversation} />}

      <div className="flex-1 overflow-y-auto p-4">
        <Transcript events={events} />
      </div>

      {/* Pending prompts sit outside the scrollable transcript so a paused
          Turn stays visible without hunting for it — the panel is
          non-modal, so this never traps focus. */}
      {Object.values(pending).map((p) => (
        <PermissionPrompt
          key={p.reqId}
          pending={p}
          workingDir={conversation?.workingDir ?? ''}
          onAnswer={answerPermission}
        />
      ))}

      {config && composerReady && <Composer config={config} conversation={conversation} onSend={send} />}
    </div>
  );
}

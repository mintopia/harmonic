import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';
import { subscribe } from '../ws';
import type { AppConfig, Conversation, ConversationEvent } from '../types';
import { segmentTranscript } from '../conversation-transcript-model';
import { loadConversationId, storeConversationId } from '../conversation-storage';
import { EventStream } from './EventStream';
import { ModelCombobox } from './ModelCombobox';
import { Icon } from './Icon';
import { toastError } from '../toast';
import { btnPrimary, btnQuiet, field, headline, labelType } from '../ui';

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

  useEffect(() => {
    if (conversationId === null) return;
    let live = true;
    api.conversation(conversationId).then((c) => live && setConversation(c), toastError);
    // Replay the persisted stream, then append live events as they arrive —
    // one representation for both (TaskDetail.tsx's pattern), deduped by id.
    api.conversationEvents(conversationId).then(({ events }) => live && setEvents(events), toastError);
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'conversation_event' && msg.event.conversationId === conversationId) {
        setEvents((current) =>
          current.some((e) => e.id === msg.event.id) ? current : [...current, msg.event],
        );
      }
      if (msg.type === 'conversation_changed' && msg.conversation.id === conversationId) {
        setConversation(msg.conversation);
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
    api.endConversation(conversationId).then(setConversation, toastError);
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

      <div className="flex-1 overflow-y-auto p-4">
        <Transcript events={events} />
      </div>

      {config && composerReady && <Composer config={config} conversation={conversation} onSend={send} />}
    </div>
  );
}

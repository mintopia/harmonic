import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../../api';
import { isTurnRunning } from '../../conversation-steering-model';
import { toastError } from '../../toast';
import type { AppConfig, Conversation, ConversationEvent, Workspace } from '../../types';
import { btnPrimary, btnQuietDestructive, field, labelType, selectField } from '../../ui';
import { DiscoveryModelPicker } from '../DiscoveryModelPicker.js';
import { Icon } from '../Icon';
import { providerLabel } from '../TaskIdentity';

const fieldLabel = `mb-1 block ${labelType} text-muted`;

export function Composer({
  config,
  workspace,
  conversation,
  events,
  expanded,
  onSend,
}: {
  config: AppConfig;
  workspace: Workspace | null;
  conversation: Conversation | null;
  events: ConversationEvent[];
  expanded: boolean;
  onSend: (
    fields: { harness: string; model: string; permissionMode: Conversation['permissionMode'] },
    text: string,
  ) => Promise<{ queued: boolean }>;
}) {
  const [harness, setHarness] = useState(workspace?.chatHarness ?? config.chat.harness);
  const [model, setModel] = useState(workspace?.chatModel ?? config.chat.model);
  const [permissionMode, setPermissionMode] = useState<Conversation['permissionMode']>('ask');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [queued, setQueued] = useState(false);
  const queuedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (queuedTimer.current) clearTimeout(queuedTimer.current);
  }, []);

  const locked = conversation !== null;
  const ended = conversation?.state === 'ended';
  const running = conversation?.state === 'active' && isTurnRunning(events);
  const models = (config.harnesses[harness]?.models ?? []).map((model) => model.id);

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
      const result = await onSend({ harness, model, permissionMode }, trimmed);
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
        <div className={`mb-2 grid gap-2 ${expanded ? 'sm:grid-cols-2' : ''}`}>
          <div>
            <label className={fieldLabel} htmlFor="conv-harness">
              Harness
            </label>
            <select
              id="conv-harness"
              className={`${selectField} w-full`}
              value={harness}
              onChange={(e) => pickHarness(e.target.value)}
            >
              {Object.keys(config.harnesses).map((h) => (
                <option key={h} value={h}>
                  {providerLabel(h)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={fieldLabel} htmlFor="conv-model">
              Model
            </label>
            <DiscoveryModelPicker id="conv-model" harness={harness} value={model} onChange={setModel} options={models} />
          </div>
          <div>
            <label className={fieldLabel} htmlFor="conv-permission-mode">
              Permission mode
            </label>
            <select
              id="conv-permission-mode"
              className={`${selectField} w-full`}
              value={permissionMode}
              onChange={(event) => setPermissionMode(event.target.value === 'automatic' ? 'automatic' : 'ask')}
            >
              <option value="ask">Ask each turn</option>
              <option value="automatic">Automatic</option>
            </select>
          </div>
        </div>
      )}
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
                ? `Message ${providerLabel(harness)}… (Enter queues it for after this turn)`
                : `Message ${providerLabel(harness)}… (Enter to send, Shift+Enter for a newline)`
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
      {!ended && (
        <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-label text-faint">
          <span><b className="font-semibold text-muted">Enter</b> {running ? 'queues' : 'to send'}</span>
          <span><b className="font-semibold text-muted">Shift ↵</b> newline</span>
          <span><b className="font-semibold text-muted">/</b> commands</span>
        </div>
      )}
    </div>
  );
}

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { isTurnRunning } from '../../conversation-steering-model';
import { toastError } from '../../toast';
import type { AppConfig, Conversation, ConversationEvent, Workspace } from '../../types';
import { btnPrimary, field, labelType, selectField } from '../../ui';
import { computeContextUsage, formatContextUsage, formatTokenBreakdown } from '../../conversation-telemetry-model';
import { formatCost } from '../../cost';
import { DiscoveryModelPicker } from '../DiscoveryModelPicker.js';
import { Icon } from '../Icon';
import { providerLabel } from '../TaskIdentity';

const fieldLabel = `mb-1 block ${labelType} text-muted`;

export function ContextMeter({ conversation, onOpen }: { conversation: Conversation; onOpen?: () => void }) {
  const context = formatContextUsage(computeContextUsage(conversation));
  const fraction =
    conversation.contextWindow && conversation.contextTokens != null
      ? Math.min(1, Math.max(0, conversation.contextTokens / conversation.contextWindow))
      : null;
  const pct = fraction != null ? Math.round(fraction * 100) : null;
  const breakdown = formatTokenBreakdown(conversation.usage);
  const tip = [
    context.value ? `Context ${context.value}` : null,
    context.note,
    ...(breakdown ?? []).map((row) => `${row.label}: ${row.value}`),
  ]
    .filter(Boolean)
    .join('\n');
  const label = `Context ${pct != null ? `${pct}% used` : context.value || 'unknown'}`;
  const inner = (
    <>
      {fraction != null && (
        <span aria-hidden className="h-1 w-9 overflow-hidden rounded-full bg-raised">
          <span
            className={`block h-full rounded-full ${fraction > 0.85 ? 'bg-running-dot' : 'bg-accent'}`}
            style={{ width: `${fraction * 100}%` }}
          />
        </span>
      )}
      <span className="font-data tabular-nums text-muted">{pct != null ? `${pct}%` : context.value || '—'}</span>
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={tip}
        aria-label={`${label}. Open context details`}
        className="inline-flex items-center gap-1.5 rounded-sm transition-colors hover:text-ink [&>span:last-child]:hover:text-ink"
      >
        {inner}
      </button>
    );
  }
  return (
    <span title={tip} aria-label={label} className="inline-flex items-center gap-1.5">
      {inner}
    </span>
  );
}

export function Composer({
  config,
  workspace,
  conversation,
  events,
  expanded,
  onOpen,
  onSend,
  onOpenContext,
}: {
  config: AppConfig;
  workspace: Workspace | null;
  conversation: Conversation | null;
  events: ConversationEvent[];
  expanded: boolean;
  onOpen?: (fields: { harness: string; model: string; permissionMode: Conversation['permissionMode'] }) => Promise<void>;
  onSend: (
    fields: { harness: string; model: string; permissionMode: Conversation['permissionMode'] },
    text: string,
  ) => Promise<{ queued: boolean }>;
  onOpenContext?: () => void;
}) {
  const [harness, setHarness] = useState(workspace?.chatHarness ?? config.chat.harness);
  const [model, setModel] = useState(workspace?.chatModel ?? config.chat.model);
  const [permissionMode, setPermissionMode] = useState<Conversation['permissionMode']>('ask');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [caret, setCaret] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const queuedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opened = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const commandListId = useId();

  useEffect(() => () => {
    if (queuedTimer.current) clearTimeout(queuedTimer.current);
  }, []);

  const locked = conversation !== null;
  const running = conversation?.state === 'active' && isTurnRunning(events);
  const displayedHarness = conversation?.harness ?? harness;
  const models = (config.harnesses[harness]?.models ?? []).map((model) => model.id);
  const commandPrefix = displayedHarness === 'opencode' ? '/' : '$';
  const token = text.slice(0, caret).match(/(?:^|\s)(\S*)$/)?.[1] ?? '';
  const commandQuery = token.startsWith(commandPrefix) ? token.slice(commandPrefix.length) : null;
  const commands = conversation?.commands ?? [];
  const shownCommands = commandQuery === null
    ? []
    : commands.filter((command) => command.name.toLocaleLowerCase().startsWith(commandQuery.toLocaleLowerCase())).slice(0, 8);
  const pickerVisible = pickerOpen && shownCommands.length > 0;

  const selectCommand = (command: NonNullable<Conversation['commands']>[number]) => {
    const start = caret - token.length;
    const next = `${text.slice(0, start)}${commandPrefix}${command.name} ${text.slice(caret)}`;
    const nextCaret = start + commandPrefix.length + command.name.length + 1;
    setText(next);
    setCaret(nextCaret);
    setPickerOpen(false);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  useEffect(() => {
    if (locked || opened.current || !onOpen) return;
    opened.current = true;
    void onOpen({ harness, model, permissionMode }).catch(toastError);
  }, [harness, locked, model, onOpen, permissionMode]);

  const pickHarness = (h: string) => {
    setHarness(h);
    const cfg = config.harnesses[h];
    if (cfg) setModel(cfg.defaultModel);
  };

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((current) => Math.min(current + 1, shownCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((current) => Math.max(current - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectCommand(shownCommands[highlight] ?? shownCommands[0]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPickerOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-edge bg-surface p-3 max-md:p-2.5">
      {!locked && (
        <div className="mb-2 flex flex-col gap-2.5">
          <div className={`grid items-start gap-2 ${expanded ? 'sm:grid-cols-2' : ''}`}>
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
          </div>
          <div>
            <span className={fieldLabel}>Permission mode</span>
            <div
              id="conv-permission-mode"
              role="group"
              aria-label="Permission mode"
              className="inline-flex rounded-md border border-edge bg-field p-0.5"
            >
              {(['ask', 'automatic'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={permissionMode === mode}
                  onClick={() => setPermissionMode(mode)}
                  className={`min-h-11 rounded px-3 text-small font-medium transition-colors ${
                    permissionMode === mode ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
                  }`}
                >
                  {mode === 'ask' ? 'Ask each turn' : 'Automatic'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {queued && (
        <p role="status" className="mb-1.5 text-label text-muted motion-safe:animate-[toast-in_150ms_var(--ease-out-quint)]">
          Queued — will send once the current turn finishes.
        </p>
      )}
      <div className="relative flex items-end gap-2">
        {pickerVisible && (
          <ul
            id={commandListId}
            role="listbox"
            aria-label="Commands"
            className="absolute bottom-full left-0 right-12 z-10 mb-2 max-h-64 overflow-auto rounded-md border border-edge bg-surface py-1 shadow-bar"
          >
            {shownCommands.map((command, index) => (
              <li
                key={command.name}
                id={`${commandListId}-${index}`}
                role="option"
                aria-selected={index === highlight}
                className={`cursor-pointer px-3 py-2 ${index === highlight ? 'bg-raised' : ''}`}
                onMouseEnter={() => setHighlight(index)}
                onPointerDown={(event) => {
                  event.preventDefault();
                  selectCommand(command);
                }}
              >
                <span className="block text-data font-semibold text-ink">{commandPrefix}{command.name}</span>
                <span className="block text-small text-muted">{command.description}</span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textarea}
          role="combobox"
          aria-label="Message"
          aria-autocomplete="list"
          aria-controls={pickerVisible ? commandListId : undefined}
          aria-expanded={pickerVisible}
          aria-activedescendant={pickerVisible ? `${commandListId}-${highlight}` : undefined}
          className={`${field} min-h-16 flex-1 resize-none max-md:min-h-14 max-md:pr-14`}
          value={text}
          placeholder={
            running
              ? `Message ${providerLabel(displayedHarness)}… (Enter queues it for after this turn)`
              : `Message ${providerLabel(displayedHarness)}… (Enter to send, Shift+Enter for a newline)`
          }
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setPickerOpen(true);
            setHighlight(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <button
          aria-label="Send"
          className={`${btnPrimary} w-11 px-0 max-md:absolute max-md:bottom-2 max-md:right-2`}
          disabled={busy || !text.trim()}
          onClick={send}
        >
          <Icon name="send" />
        </button>
      </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-label text-faint">
          <span className="max-md:hidden"><b className="font-semibold text-muted">Enter</b> {running ? 'queues' : 'to send'}</span>
          <span className="max-md:hidden"><b className="font-semibold text-muted">Shift ↵</b> newline</span>
          <span className="max-md:hidden"><b className="font-semibold text-muted">/</b> commands</span>
          {conversation && (
            <div className="ml-auto flex items-center gap-2.5 normal-case tracking-normal">
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`size-1.5 rounded-full ${conversation.state === 'active' ? 'bg-ready-dot' : 'bg-faint'}`}
                />
                <span className="text-muted">{providerLabel(conversation.harness)}</span>
                <span className="font-data text-faint">{conversation.model}</span>
              </span>
              {formatCost(conversation.cost) && (
                <span className="font-data tabular-nums text-muted">{formatCost(conversation.cost)}</span>
              )}
              <ContextMeter conversation={conversation} onOpen={onOpenContext} />
            </div>
          )}
        </div>
    </div>
  );
}

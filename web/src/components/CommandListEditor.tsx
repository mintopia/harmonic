import type { CommandOverlayEntry, VerificationCommand } from '../types';
import { chip, field } from '../ui';
import { EntryList, ListEditor } from './EntryList';
import { EnvEditor } from './EnvEditor';
import { Switch } from './Switch';
import { FieldError, fieldLabel } from './SettingsSection';
import { newCommand, setCommandField, withMissingGlobals } from './verification-override-model';

const cellUnit = 'font-normal normal-case tracking-normal text-muted';
const globalChip = `${chip} bg-raised text-muted`;

function commandLabel(command: VerificationCommand): string {
  if (command.command.trim() === '') return 'New command';
  return [command.command, ...command.args].join(' ');
}

/** The editable fields for one command verifier, shared by the global editor and a workspace overlay's local rows. */
function CommandFields({
  command,
  index,
  idPrefix,
  errorPrefix,
  fieldErrors,
  set,
}: {
  command: VerificationCommand;
  index: number;
  idPrefix: string;
  errorPrefix: string;
  fieldErrors: Record<string, string>;
  set: (command: VerificationCommand) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1.5fr)_6rem] gap-3">
        <div>
          <label className={fieldLabel} htmlFor={`${idPrefix}-command-${index}`}>
            Command
          </label>
          <input
            id={`${idPrefix}-command-${index}`}
            className={`${field} font-data`}
            placeholder="npm"
            value={command.command}
            onChange={(e) => set(setCommandField(command, 'command', e.target.value))}
          />
          <FieldError message={fieldErrors[`${errorPrefix}.${index}.command`]} />
        </div>
        <div>
          <label className={fieldLabel} htmlFor={`${idPrefix}-timeout-${index}`}>
            Timeout <span className={cellUnit}>s</span>
          </label>
          <input
            id={`${idPrefix}-timeout-${index}`}
            type="number"
            min={1}
            className={`${field} tabular-nums`}
            value={command.timeoutSeconds}
            onChange={(e) => set(setCommandField(command, 'timeoutSeconds', e.target.value))}
          />
        </div>
      </div>
      <div>
        <label className={fieldLabel}>Arguments</label>
        <ListEditor items={command.args} onChange={(args) => set({ ...command, args })} ariaLabel="Argument" />
      </div>
      <div>
        <label className={fieldLabel}>Environment</label>
        <EnvEditor env={command.env} onChange={(env) => set({ ...command, env })} />
      </div>
    </>
  );
}

export function CommandListEditor({
  commands,
  onChange,
  idPrefix,
  errorPrefix,
  fieldErrors,
  emptyText,
}: {
  commands: VerificationCommand[];
  onChange: (commands: VerificationCommand[]) => void;
  idPrefix: string;
  errorPrefix: string;
  fieldErrors: Record<string, string>;
  emptyText: string;
}) {
  return (
    <EntryList
      items={commands}
      onChange={onChange}
      groupLabel="Commands"
      addLabel="+ Add command"
      emptyText={emptyText}
      itemNoun="command"
      makeItem={newCommand}
      renderTitle={(command) => {
        const configured = command.command.trim() !== '';
        return (
          <span className={configured ? 'font-data text-ink' : 'italic text-faint'}>
            {commandLabel(command)}
          </span>
        );
      }}
      renderMeta={(command) => <span className="tabular-nums">{command.timeoutSeconds}s</span>}
      renderBody={(command, index, set) => (
        <CommandFields
          command={command}
          index={index}
          idPrefix={idPrefix}
          errorPrefix={errorPrefix}
          fieldErrors={fieldErrors}
          set={set}
        />
      )}
    />
  );
}

/**
 * The Workspace-scope, additive command editor (ADR-0037): renders the global
 * list (locked, reorderable, disable-able — resolved by id against `globals`)
 * plus the Workspace's own local commands, in overlay order. A `ref` whose
 * global no longer exists renders as a muted, droppable "Removed" row.
 */
export function CommandOverlayEditor({
  overlay,
  globals,
  onChange,
  idPrefix,
  errorPrefix,
  fieldErrors,
  emptyText,
}: {
  overlay: CommandOverlayEntry[] | null;
  globals: VerificationCommand[];
  onChange: (overlay: CommandOverlayEntry[]) => void;
  idPrefix: string;
  errorPrefix: string;
  fieldErrors: Record<string, string>;
  emptyText: string;
}) {
  const globalById = new Map(globals.map((g) => [g.id, g]));
  const rows = withMissingGlobals<CommandOverlayEntry>(
    overlay,
    globals.map((g) => g.id),
  );
  const setEnabled = (index: number, enabled: boolean) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, enabled } : row)));

  return (
    <EntryList
      items={rows}
      onChange={onChange}
      groupLabel="Commands"
      addLabel="+ Add command"
      emptyText={emptyText}
      itemNoun="command"
      makeItem={() => ({ kind: 'local' as const, enabled: true, command: newCommand() })}
      isLocked={(entry) => entry.kind === 'global'}
      canRemoveLocked={(entry) => entry.kind === 'global' && !globalById.has(entry.ref)}
      renderRowControl={(entry, index) => (
        <Switch
          checked={entry.enabled}
          onChange={(enabled) => setEnabled(index, enabled)}
          label={entry.enabled ? `Disable ${idPrefix} command ${index + 1}` : `Enable ${idPrefix} command ${index + 1}`}
        />
      )}
      renderTitle={(entry) => {
        if (entry.kind === 'global') {
          const global = globalById.get(entry.ref);
          const label = global ? commandLabel(global) : 'Removed';
          const configured = global !== undefined;
          return (
            <span
              className={`font-data ${configured ? 'text-ink' : 'italic text-faint line-through'} ${
                entry.enabled ? '' : 'opacity-60 line-through'
              }`}
            >
              {label}
            </span>
          );
        }
        const configured = entry.command.command.trim() !== '';
        return (
          <span
            className={`${configured ? 'font-data text-ink' : 'italic text-faint'} ${
              entry.enabled ? '' : 'opacity-60 line-through'
            }`}
          >
            {commandLabel(entry.command)}
          </span>
        );
      }}
      renderMeta={(entry) =>
        entry.kind === 'global' ? (
          <span className={globalChip}>Global</span>
        ) : (
          <span className="tabular-nums">{entry.command.timeoutSeconds}s</span>
        )
      }
      renderLockedBody={(entry) => {
        const global = entry.kind === 'global' ? globalById.get(entry.ref) : undefined;
        if (!global) {
          return <p className="text-small text-muted">This global command was removed. Remove this row too.</p>;
        }
        return (
          <div className="space-y-1 text-small text-muted">
            <p>Managed globally — edit it in Global settings.</p>
            <p className="font-data text-data text-ink">{commandLabel(global)}</p>
            <p>
              Timeout {global.timeoutSeconds}s
              {Object.keys(global.env).length > 0 ? ` · ${Object.keys(global.env).length} env var(s)` : ''}
            </p>
          </div>
        );
      }}
      renderBody={(entry, index, set) => {
        if (entry.kind !== 'local') return null;
        return (
          <CommandFields
            command={entry.command}
            index={index}
            idPrefix={idPrefix}
            errorPrefix={errorPrefix}
            fieldErrors={fieldErrors}
            set={(command) => set({ ...entry, command })}
          />
        );
      }}
    />
  );
}

import type { VerificationCommand } from '../types';
import { field } from '../ui';
import { EntryList, ListEditor } from './EntryList';
import { FieldError, fieldLabel } from './SettingsSection';
import { EMPTY_COMMAND, setCommandField } from './verification-override-model';

const cellUnit = 'font-normal normal-case tracking-normal text-muted';

function commandLabel(command: VerificationCommand): string {
  if (command.command.trim() === '') return 'New command';
  return [command.command, ...command.args].join(' ');
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
      makeItem={() => ({ ...EMPTY_COMMAND, args: [], env: {} })}
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
        </>
      )}
    />
  );
}

import type { VerificationCommand } from '../types';
import { field } from '../ui';
import { FieldError, fieldLabel } from './SettingsSection';
import { EMPTY_COMMAND, argsText, setCommandField } from './verification-override-model';

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
  const setCommand = (index: number, command: VerificationCommand) =>
    onChange(commands.map((current, i) => (i === index ? command : current)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className={fieldLabel}>Commands</span>
        <button
          type="button"
          className="text-small text-accent"
          onClick={() => onChange([...commands, EMPTY_COMMAND])}
        >
          Add command
        </button>
      </div>
      {commands.length === 0 ? (
        <p className="text-small text-muted">{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-5">
          {commands.map((command, index) => (
            <div key={index} className="flex flex-col gap-3 border-l-2 border-edge pl-3">
              <div className="flex items-center justify-between">
                <span className={fieldLabel}>Command {index + 1}</span>
                <button
                  type="button"
                  className="text-small text-failed"
                  onClick={() => onChange(commands.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
              <div>
                <label className={fieldLabel} htmlFor={`${idPrefix}-command-${index}`}>
                  Command
                </label>
                <input
                  id={`${idPrefix}-command-${index}`}
                  className={`${field} font-data`}
                  placeholder="npm"
                  value={command.command}
                  onChange={(e) => setCommand(index, setCommandField(command, 'command', e.target.value))}
                />
                <FieldError message={fieldErrors[`${errorPrefix}.${index}.command`]} />
              </div>
              <div>
                <label className={fieldLabel} htmlFor={`${idPrefix}-args-${index}`}>
                  Arguments <span className="normal-case text-muted">(space-separated)</span>
                </label>
                <input
                  id={`${idPrefix}-args-${index}`}
                  className={`${field} font-data`}
                  placeholder="test"
                  value={argsText(command)}
                  onChange={(e) => setCommand(index, setCommandField(command, 'args', e.target.value))}
                />
              </div>
              <div>
                <label className={fieldLabel} htmlFor={`${idPrefix}-timeout-${index}`}>
                  Timeout (seconds)
                </label>
                <input
                  id={`${idPrefix}-timeout-${index}`}
                  type="number"
                  min={1}
                  className={`${field} w-40 tabular-nums`}
                  value={command.timeoutSeconds}
                  onChange={(e) => setCommand(index, setCommandField(command, 'timeoutSeconds', e.target.value))}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

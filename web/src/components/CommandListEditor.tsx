import type { VerificationCommand } from '../types';
import { field, touchOverlay } from '../ui';
import { FieldError, fieldLabel } from './SettingsSection';
import { EMPTY_COMMAND, argsText, setCommandField } from './verification-override-model';

const cellLabel = 'mb-1 block text-label font-semibold uppercase text-faint';
const cellUnit = 'font-normal normal-case tracking-normal text-muted';

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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className={fieldLabel}>Commands</span>
        <button
          type="button"
          className="text-small font-semibold text-accent hover:text-accent-hot"
          onClick={() => onChange([...commands, EMPTY_COMMAND])}
        >
          + Add command
        </button>
      </div>
      {commands.length === 0 ? (
        <p className="rounded-md border border-dashed border-hairline bg-sunken px-3.5 py-3 text-small text-faint">
          {emptyText}
        </p>
      ) : (
        <div className="rounded-md border border-hairline bg-sunken p-1.5">
          {commands.map((command, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_5rem_auto] items-end gap-3 rounded-sm p-2 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-hairline"
            >
              <div>
                <label className={cellLabel} htmlFor={`${idPrefix}-command-${index}`}>
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
                <label className={cellLabel} htmlFor={`${idPrefix}-args-${index}`}>
                  Arguments <span className={cellUnit}>space-sep</span>
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
                <label className={cellLabel} htmlFor={`${idPrefix}-timeout-${index}`}>
                  Timeout <span className={cellUnit}>s</span>
                </label>
                <input
                  id={`${idPrefix}-timeout-${index}`}
                  type="number"
                  min={1}
                  className={`${field} tabular-nums`}
                  value={command.timeoutSeconds}
                  onChange={(e) => setCommand(index, setCommandField(command, 'timeoutSeconds', e.target.value))}
                />
              </div>
              <button
                type="button"
                aria-label={`Remove command ${index + 1}`}
                className="relative mb-1.5 self-end text-faint transition-colors hover:text-fail"
                onClick={() => onChange(commands.filter((_, i) => i !== index))}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <span aria-hidden="true" className={touchOverlay} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

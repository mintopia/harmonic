import { useEffect, useState } from 'react';
import { chip, field, labelType } from '../ui';
import { Switch } from './Switch';
import { parseVarInput, resetRow, setRowValue, type Inherited, type VarRow, type VarSource } from './workflow-vars-model';

const SOURCE: Record<VarSource, { word: string; tone: string }> = {
  default: { word: 'Default', tone: 'bg-raised text-muted' },
  workspace: { word: 'Workspace', tone: 'bg-running-tint text-running' },
  ticket: { word: 'Ticket', tone: 'bg-accent-tint text-accent' },
};

const th = `${labelType} px-2 py-2 text-left text-muted`;
const td = 'px-2 py-3 align-top';

export function VariablesTable({
  rows,
  level,
  defaultCell,
  inheritedFor,
  onChange,
  onInvalid,
}: {
  rows: readonly VarRow[];
  level: 'workspace' | 'ticket';
  defaultCell: (row: VarRow) => string;
  inheritedFor: (row: VarRow) => Inherited;
  onChange: (rows: VarRow[]) => void;
  onInvalid?: (invalid: boolean) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const errors = Object.fromEntries(
    rows.flatMap((row) => {
      const draft = drafts[row.name];
      const parsed = draft === undefined ? null : parseVarInput(row.name, row.default, draft);
      return parsed && !parsed.ok ? [[row.name, parsed.message]] : [];
    }),
  );
  const invalid = Object.keys(errors).length > 0;
  useEffect(() => onInvalid?.(invalid), [invalid, onInvalid]);

  const replace = (next: VarRow) => onChange(rows.map((row) => (row.name === next.name ? next : row)));
  const clearDraft = (name: string) => setDrafts(({ [name]: _gone, ...rest }) => rest);
  const edit = (row: VarRow, text: string) => {
    setDrafts((current) => ({ ...current, [row.name]: text }));
    const parsed = parseVarInput(row.name, row.default, text);
    if (parsed.ok) replace(setRowValue(row, parsed.value, level, inheritedFor(row)));
  };

  return (
    <table className="w-full border-collapse text-left">
      <thead>
        <tr className="border-b border-hairline">
          <th className={th}>Variable</th>
          <th className={th}>Default</th>
          <th className={th}>Value</th>
          <th className={th}>Source</th>
          <th className={th}>
            <span className="sr-only">Reset</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const error = errors[row.name];
          const source = SOURCE[row.source];
          return (
            <tr key={row.name} className="border-b border-hairline last:border-b-0">
              <td className={td}>
                <span className="font-data font-semibold text-ink">{row.name}</span>
                <div className="text-small text-faint">{row.type}</div>
              </td>
              <td className={`${td} font-data text-data text-ink`}>{defaultCell(row)}</td>
              <td className={`${td} w-[40%]`}>
                {row.type === 'boolean' ? (
                  <div className="flex min-h-9 items-center">
                    <Switch checked={row.value === true} label={row.name} onChange={(value) => replace(setRowValue(row, value, level, inheritedFor(row)))}>
                      <span className="font-data text-small">{String(row.value)}</span>
                    </Switch>
                  </div>
                ) : (
                  <>
                    <input
                      aria-label={row.name}
                      aria-invalid={error !== undefined}
                      className={`${field} min-h-9 py-1 font-data text-data ${error ? 'border-fail focus:border-fail' : ''}`}
                      value={drafts[row.name] ?? String(row.value)}
                      onChange={(e) => edit(row, e.target.value)}
                      onBlur={() => !error && clearDraft(row.name)}
                    />
                    {error && (
                      <p role="alert" className="mt-1 text-small text-fail">
                        {error}
                      </p>
                    )}
                  </>
                )}
              </td>
              <td className={td}>
                <span className={`${chip} ${source.tone}`}>{source.word}</span>
              </td>
              <td className={td}>
                <button
                  type="button"
                  disabled={row.source !== level && error === undefined}
                  className="text-small font-semibold text-accent hover:text-accent-hot disabled:font-normal disabled:text-faint disabled:hover:text-faint"
                  onClick={() => {
                    clearDraft(row.name);
                    replace(resetRow(row, inheritedFor(row)));
                  }}
                >
                  Reset
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

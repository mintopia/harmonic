import { useState } from 'react';
import { btnGhost, btnQuiet, field, touchTarget, touchTargetInline } from '../ui';
import { renameRecordKey } from './settings-rename';

/**
 * Holds the in-progress name in local state so typing never rewrites the parent
 * object's key — which is what remounted the row and stole focus. Committed to
 * the parent only on `commit` (blur), via {@link renameRecordKey}, which
 * silently keeps the old name on an empty or colliding rename.
 */
function useKeyRename<V>(record: Record<string, V>, onChange: (next: Record<string, V>) => void) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return {
    nameFor: (key: string) => drafts[key] ?? key,
    setName: (key: string, value: string) => setDrafts((d) => ({ ...d, [key]: value })),
    commit: (key: string) => {
      const draft = drafts[key];
      setDrafts((d) => {
        const { [key]: _omit, ...rest } = d;
        return rest;
      });
      if (draft === undefined) return;
      const next = renameRecordKey(record, key, draft);
      if (next !== record) onChange(next);
    },
  };
}

/** Key/value editor for an environment-variable map: rename-safe keys, masked
 * values with a reveal toggle, add/remove rows. Shared by the harness env block
 * and the verification-command env block so the two can't drift. */
export function EnvEditor({ env, onChange }: { env: Record<string, string>; onChange: (env: Record<string, string>) => void }) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const rename = useKeyRename(env, onChange);
  const entries = Object.entries(env);

  const setValue = (key: string, value: string) => onChange({ ...env, [key]: value });
  const remove = (key: string) => {
    const { [key]: _dropped, ...rest } = env;
    onChange(rest);
  };
  const add = () => {
    let key = 'NEW_VAR';
    let i = 1;
    while (key in env) key = `NEW_VAR_${i++}`;
    onChange({ ...env, [key]: '' });
  };

  return (
    <div className="space-y-2.5">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-center gap-2.5">
          <input
            aria-label="Env var name"
            className={`${field} min-w-0 shrink-0 basis-1/3 font-data`}
            value={rename.nameFor(key)}
            onChange={(e) => rename.setName(key, e.target.value)}
            onBlur={() => rename.commit(key)}
          />
          <input
            aria-label="Env var value"
            type={revealed[key] ? 'text' : 'password'}
            className={`${field} min-w-0 flex-1 font-data`}
            value={value}
            onChange={(e) => setValue(key, e.target.value)}
          />
          <button
            type="button"
            aria-label={revealed[key] ? 'Hide value' : 'Reveal value'}
            onClick={() => setRevealed((r) => ({ ...r, [key]: !r[key] }))}
            className={`${touchTargetInline} ${btnQuiet}`}
          >
            {revealed[key] ? 'Hide' : 'Show'}
          </button>
          <button type="button" aria-label="Remove env var" onClick={() => remove(key)} className={`${touchTarget} ${btnQuiet}`}>
            ✕
          </button>
        </div>
      ))}
      {entries.length === 0 && <p className="text-body text-muted">No environment variables set.</p>}
      <button type="button" onClick={add} className={btnGhost}>
        + Add variable
      </button>
    </div>
  );
}

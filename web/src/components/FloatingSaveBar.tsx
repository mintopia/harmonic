import { btnGhost, btnPrimary } from '../ui';

export function FloatingSaveBar({
  error,
  saving,
  onDiscard,
  onSave,
}: {
  error: string | null;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-10 mt-6 max-w-3xl">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-surface px-4 py-2.5 shadow-bar">
        <p className="font-medium text-muted">Unsaved changes</p>
        {error && (
          <p className="min-w-0 flex-1 truncate text-fail" title={error}>
            {error}
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button disabled={saving} onClick={onDiscard} className={btnGhost}>
            Discard
          </button>
          <button disabled={saving} onClick={onSave} className={btnPrimary}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

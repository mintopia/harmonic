import { useState } from 'react';
import { ApiError, api } from '../../api';
import { toastError } from '../../toast';
import { copyCode, parseSaveError, savedLabel, validateCode, type SaveIssue } from '../../prompt-library-model';
import { btnGhost, btnPrimary, btnQuietDestructive } from '../../ui';
import { ConfirmDialog } from '../ConfirmDialog';
import { usePromptsFlow } from './PromptsFlow';
import { SourceBadge } from './SourceBadge';

export function PromptHeader({ blocked = false, onIssue, onDiscarded }: { blocked?: boolean; onIssue?: (issue: SaveIssue | null) => void; onDiscarded?: () => void }) {
  const flow = usePromptsFlow();
  const { current: prompt, isNew, prompts, draft } = flow;
  const readOnly = prompt?.bundled === true;
  const { code, description, text } = draft;
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const dirty = flow.changes > 0;
  const saveDisabled = busy || blocked || !dirty || (isNew && (code === '' || validateCode(code, prompts) !== null));

  const save = async () => {
    setBusy(true);
    onIssue?.(null);
    try {
      const saved = isNew ? await api.createPrompt({ code, description, text }) : await api.updatePrompt(prompt!.code, { description, text });
      flow.afterSave(saved);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        const issue = parseSaveError(e.message, text, prompts.map((p) => p.code));
        if (onIssue) onIssue(issue);
        else setActionError(e.message);
      } else toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    if (!prompt) return;
    setBusy(true);
    try {
      await api.deletePrompt(prompt.code);
      flow.afterDelete();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    if (!prompt) return;
    setBusy(true);
    setActionError(null);
    try {
      flow.afterDuplicate(await api.duplicatePrompt(prompt.code, copyCode(prompt.code, prompts)));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const saved = prompt ? savedLabel(prompt.updatedAt) : null;
  const subtitle = [description, saved].filter(Boolean).join(' · ');

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="font-data text-display font-semibold text-ink">{isNew ? 'New prompt' : prompt?.code}</h2>
            {prompt && <SourceBadge bundled={prompt.bundled} />}
            {dirty && !isNew && <span className="rounded-full bg-raised px-2 py-0.5 text-badge font-semibold uppercase tracking-[.06em] text-muted">Edited</span>}
          </div>
          <p className="text-body text-muted">{subtitle || (isNew ? 'Name it, say what it is for, then write the text.' : '')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {prompt && !readOnly && (
            <button type="button" className={btnQuietDestructive} disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete…
            </button>
          )}
          {prompt && (
            <button type="button" className={readOnly ? btnPrimary : btnGhost} disabled={busy} onClick={() => void duplicate()}>
              Duplicate
            </button>
          )}
          {!readOnly && (
            <>
              <button
                type="button"
                className={btnGhost}
                disabled={busy || !dirty}
                onClick={() => {
                  flow.discard();
                  onDiscarded?.();
                }}
              >
                Discard changes
              </button>
              <button type="button" className={btnPrimary} disabled={saveDisabled} onClick={() => void save()}>
                Save
              </button>
            </>
          )}
        </div>
      </div>
      {actionError && (
        <p role="alert" className="rounded-sm bg-fail-tint px-2.5 py-2 text-small text-fail">
          {actionError}
        </p>
      )}
      {confirmDelete && prompt && (
        <ConfirmDialog
          label="Delete prompt"
          title={`Delete ${prompt.code}?`}
          confirmLabel="Delete prompt"
          tone="danger"
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        >
          This removes the prompt from the Library. A prompt that other prompts include cannot be deleted.
        </ConfirmDialog>
      )}
    </>
  );
}

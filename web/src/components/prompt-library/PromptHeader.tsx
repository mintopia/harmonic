import { useState } from 'react';
import { ApiError, api } from '../../api';
import { toastError } from '../../toast';
import { copyCode, parseSaveError, renameRewrites, savedLabel, validateCode, type SaveIssue } from '../../prompt-library-model';
import { btnGhost, btnPrimary, btnQuietDestructive, field, labelType, panelTitle } from '../../ui';
import { ConfirmDialog } from '../ConfirmDialog';
import { Modal } from '../Modal';
import { usePromptsFlow } from './PromptsFlow';
import { SourceBadge } from './SourceBadge';

export function PromptHeader({ blocked = false, onIssue, onDiscarded }: { blocked?: boolean; onIssue?: (issue: SaveIssue | null) => void; onDiscarded?: () => void }) {
  const flow = usePromptsFlow();
  const { current: prompt, isNew, prompts, draft } = flow;
  const { code, description, text } = draft;
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [forkCode, setForkCode] = useState<string | null>(null);
  const [forkOpen, setForkOpen] = useState(false);
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const renameIssue = renameTo === null ? null : validateCode(renameTo, prompts);
  const dirty = flow.changes > 0;
  const saveDisabled = busy || blocked || !dirty || (isNew && (code === '' || validateCode(code, prompts) !== null));

  const save = async (newCode?: string) => {
    setForkOpen(false);
    setBusy(true);
    onIssue?.(null);
    try {
      const saved =
        newCode !== undefined
          ? await api.createPrompt({ code: newCode, description, text })
          : isNew
            ? await api.createPrompt({ code, description, text })
            : await api.updatePrompt(prompt!.code, { description, text });
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

  const rename = async () => {
    if (!prompt || renameTo === null || renameIssue !== null) return;
    setRenameTo(null);
    setBusy(true);
    setActionError(null);
    try {
      flow.afterRename(prompt.code, await api.renamePrompt(prompt.code, renameTo));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
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
          {prompt && !prompt.bundled && (
            <button type="button" className={btnQuietDestructive} disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete…
            </button>
          )}
          {prompt && !prompt.bundled && (
            <button type="button" className={btnGhost} disabled={busy || dirty} title={dirty ? 'Save or discard your changes before renaming' : undefined} onClick={() => setRenameTo(prompt.code)}>
              Rename…
            </button>
          )}
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
          <button
            type="button"
            className={btnPrimary}
            disabled={saveDisabled}
            onClick={() => {
              if (!prompt?.bundled) return void save();
              setForkCode((c) => c ?? copyCode(prompt.code, prompts));
              setForkOpen(true);
            }}
          >
            Save
          </button>
        </div>
      </div>
      {actionError && (
        <p role="alert" className="rounded-sm bg-fail-tint px-2.5 py-2 text-small text-fail">
          {actionError}
        </p>
      )}
      {forkOpen && forkCode !== null && prompt && (
        <SaveAsNewDialog
          bundled={prompt.code}
          code={forkCode}
          error={validateCode(forkCode, prompts)}
          onChange={setForkCode}
          onSave={() => void save(forkCode)}
          onCancel={() => setForkOpen(false)}
        />
      )}
      {renameTo !== null && prompt && (
        <ConfirmDialog
          label="Rename prompt"
          title={`Rename ${prompt.code}`}
          confirmLabel="Rename prompt"
          tone="primary"
          confirmDisabled={renameIssue !== null}
          onConfirm={() => void rename()}
          onCancel={() => setRenameTo(null)}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-small font-semibold text-ink">New code</span>
            <input autoFocus value={renameTo} onChange={(e) => setRenameTo(e.target.value)} aria-label="New code" className={`${field} font-data`} />
          </label>
          {renameTo !== prompt.code && renameIssue && <p className="mt-1.5 text-small text-fail">{renameIssue}</p>}
          <p className="mt-3">{renameRewrites(prompt)}</p>
        </ConfirmDialog>
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

export function SaveAsNewDialog({
  bundled,
  code,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  bundled: string;
  code: string;
  error: string | null;
  onChange: (code: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal label="Save as new prompt" onClose={onCancel} className="max-w-md">
      <form
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!error) onSave();
        }}
      >
        <h2 className={`${panelTitle} mb-2 pr-6`}>Save as a new prompt</h2>
        <p className="mb-3 text-muted">
          <code className="font-data">{bundled}</code> ships with Harmonic and stays unchanged. Your edit is saved as a prompt of your own.
        </p>
        <label htmlFor="prompt-fork-code" className={`${labelType} mb-1.5 block text-muted`}>
          Code
        </label>
        <input
          id="prompt-fork-code"
          value={code}
          autoFocus
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          className={`${field} min-h-11 w-full font-data ${error ? 'border-fail' : ''}`}
        />
        {error && (
          <p role="alert" className="mt-1 text-small text-fail">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={`${btnGhost} px-3 py-1.5`} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={btnPrimary} disabled={error !== null}>
            Save as new prompt
          </button>
        </div>
      </form>
    </Modal>
  );
}

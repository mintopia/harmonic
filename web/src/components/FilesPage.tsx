import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { GitStatusEntry, Workspace, WorkspaceFile, WorkspaceFileListing } from '../types';
import { useLiveEffect } from '../useLiveEffect';
import { btnPrimary, displayTitle, gitFileStatusClass, type GitFileStatus } from '../ui';
import { Icon } from './Icon';
import { CodeViewer } from './CodeViewer';
import { ConfirmDialog } from './ConfirmDialog';
import { Markdown } from './Markdown';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type Draft = { saved: string; text: string };

export function FilesPage({ workspace, selectedPath, onSelectFile, onWorkspaceSaved }: { workspace: Workspace; selectedPath: string | null; onSelectFile: (path: string | null) => void; onWorkspaceSaved: (workspace: Workspace) => void }) {
  const { id: workspaceId, excludedDirectories: workspaceExcludedDirectories } = workspace;
  const workspaceGeneration = useRef(0);
  const selectedPathRef = useRef(selectedPath);
  const [listings, setListings] = useState<Record<string, WorkspaceFileListing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [statusEntries, setStatusEntries] = useState<GitStatusEntry[]>([]);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [excludedDirectories, setExcludedDirectories] = useState(workspaceExcludedDirectories);
  const [newExcludedDirectory, setNewExcludedDirectory] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [pendingGitAction, setPendingGitAction] = useState<string | null>(null);
  const [discardPath, setDiscardPath] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [markdownPreview, setMarkdownPreview] = useState<Record<string, boolean>>({});

  useLayoutEffect(() => { workspaceGeneration.current += 1; }, [workspaceId]);
  useEffect(() => { selectedPathRef.current = selectedPath; }, [selectedPath]);

  const load = (path: string, offset = 0) => {
    const generation = workspaceGeneration.current;
    return api.workspaceFiles(workspaceId, path, offset).then((listing) => {
      if (workspaceGeneration.current !== generation) return;
    setListings((current) => ({ ...current, [path]: offset === 0 ? listing : { ...listing, entries: [...(current[path]?.entries ?? []), ...listing.entries] } }));
    setErrors((current) => { const { [path]: _, ...rest } = current; return rest; });
    }, (error) => {
      if (workspaceGeneration.current === generation) setErrors((current) => ({ ...current, [path]: errorText(error) }));
    });
  };

  const refreshStatus = () => {
    const generation = workspaceGeneration.current;
    return api.gitStatus(workspaceId).then(({ entries }) => {
      if (workspaceGeneration.current === generation) setStatusEntries(entries);
    });
  };

  useLiveEffect((live) => {
    setListings({}); setExpanded(new Set()); setErrors({}); setStatusEntries([]); setDrafts({}); setOpenPaths([]); setSaveError(null); setMarkdownPreview({});
    api.workspaceFiles(workspaceId).then((listing) => live() && setListings({ '': listing }), (error) => live() && setErrors({ '': errorText(error) }));
    api.gitStatus(workspaceId).then(({ entries }) => live() && setStatusEntries(entries), () => live() && setStatusEntries([]));
    setExcludedDirectories(workspaceExcludedDirectories);
  }, [workspaceId, workspaceExcludedDirectories]);

  useLiveEffect((live) => {
    if (!selectedPath) { setFile(null); setFileError(null); return; }
    setFile(null); setFileError(null);
    api.workspaceFile(workspaceId, selectedPath).then((next) => {
      if (!live()) return;
      setFile(next);
      const text = next.text;
      setOpenPaths((current) => current.includes(selectedPath) ? current : [...current, selectedPath]);
      if (text !== null) {
        setDrafts((current) => current[selectedPath] ? current : { ...current, [selectedPath]: { saved: text, text } });
      }
    }, (error) => live() && setFileError(errorText(error)));
  }, [workspaceId, selectedPath]);

  const save = () => {
    const draft = selectedPath ? drafts[selectedPath] : undefined;
    if (!selectedPath || !draft || saving) return;
    const path = selectedPath;
    const generation = workspaceGeneration.current;
    setSaving(true); setSaveError(null);
    void api.saveWorkspaceFile(workspaceId, path, draft.text).then(async (saved) => {
      if (workspaceGeneration.current !== generation) return;
      const text = saved.text ?? draft.text;
      setDrafts((current) => {
        const latest = current[path];
        return latest ? { ...current, [path]: { saved: text, text: latest.text } } : current;
      });
      if (selectedPathRef.current === path) setFile(saved);
      const { entries } = await api.gitStatus(workspaceId);
      if (workspaceGeneration.current === generation) setStatusEntries(entries);
    }).catch((error) => {
      if (workspaceGeneration.current === generation && selectedPathRef.current === path) setSaveError(errorText(error));
    }).finally(() => setSaving(false));
  };

  const close = (path: string) => {
    const draft = drafts[path];
    if (draft && draft.text !== draft.saved && !window.confirm(`Discard unsaved changes in ${path}?`)) return;
    const remaining = openPaths.filter((openPath) => openPath !== path);
    setOpenPaths(remaining);
    setDrafts((current) => { const { [path]: _, ...rest } = current; return rest; });
    if (selectedPath === path) onSelectFile(remaining.at(-1) ?? null);
  };

  const rows = (path = '', depth = 0): Array<{ entry: WorkspaceFileListing['entries'][number]; depth: number }> => {
    const listing = listings[path];
    if (!listing) return [];
    return listing.entries.flatMap((entry) => [{ entry, depth }, ...(entry.type === 'directory' && !entry.excluded && expanded.has(entry.path) ? rows(entry.path, depth + 1) : [])]);
  };

  const saveExcludedDirectories = (next: string[]) => {
    api.updateWorkspace(workspaceId, { excludedDirectories: next }).then((workspace) => {
      setExcludedDirectories(workspace.excludedDirectories);
      onWorkspaceSaved(workspace);
      setExpanded(new Set());
      void load('');
    }, (error) => setErrors((current) => ({ ...current, '': errorText(error) })));
  };

  const toggleExcludedDirectory = (path: string) => {
    saveExcludedDirectories(excludedDirectories.includes(path)
      ? excludedDirectories.filter((entry) => entry !== path)
      : [...excludedDirectories, path]);
  };

  const addExcludedDirectory = () => {
    const path = newExcludedDirectory.trim();
    if (!path || excludedDirectories.includes(path)) return;
    setNewExcludedDirectory('');
    saveExcludedDirectories([...excludedDirectories, path]);
  };

  const statusFor = (path: string, directory: boolean): GitFileStatus | null => {
    const relevant = statusEntries.filter((entry) => entry.path === path || (directory && entry.path.startsWith(`${path}/`)));
    if (relevant.some((entry) => entry.indexStatus === '?')) return 'untracked';
    if (relevant.some((entry) => entry.indexStatus !== '.')) return 'staged';
    if (relevant.some((entry) => entry.worktreeStatus !== '.')) return 'modified';
    return null;
  };

  const runGitAction = (action: string, work: () => Promise<unknown>) => {
    setPendingGitAction(action);
    work().then(refreshStatus).then(() => {
      if (action === 'commit') setCommitMessage('');
    }).catch((error: unknown) => setErrors((current) => ({ ...current, '': errorText(error) }))).finally(() => setPendingGitAction(null));
  };

  const stagedEntries = statusEntries.filter((entry) => entry.indexStatus !== '.' && entry.indexStatus !== '?');
  const unstagedEntries = statusEntries.filter((entry) => entry.worktreeStatus !== '.' || entry.indexStatus === '?');
  const actionPending = pendingGitAction !== null;

  return <div className="flex h-full min-h-0 min-w-0 border-t border-hairline">
    <aside className="flex w-72 shrink-0 flex-col border-r border-hairline bg-shell">
      <div className="border-b border-hairline px-4 py-3">
        <h1 className={`${displayTitle} text-ink`}>Files</h1>
        <div aria-label="Git status legend" className="mt-1.5 flex gap-2 text-[10px] text-muted">
          {(['staged', 'modified', 'untracked'] as const).map((status) => <span key={status} className="inline-flex items-center gap-1"><span aria-hidden="true" className={`size-1.5 rounded-full ${gitFileStatusClass(status).replace('text-', 'bg-')}`} />{status}</span>)}
        </div>
        <p className="mt-1 text-tiny text-muted">Right-click a directory to include or exclude it.</p>
        <form className="mt-2 flex gap-1" onSubmit={(event) => { event.preventDefault(); addExcludedDirectory(); }}>
          <input value={newExcludedDirectory} onChange={(event) => setNewExcludedDirectory(event.target.value)} placeholder="Relative directory" aria-label="Excluded directory" className="min-w-0 flex-1 border border-hairline bg-sunken px-2 py-1 font-code text-tiny text-ink" />
          <button type="submit" className="px-2 text-tiny text-accent hover:bg-raised">Exclude</button>
        </form>
        {excludedDirectories.length > 0 && <ul className="mt-2 flex flex-wrap gap-1" aria-label="Excluded directories">
          {excludedDirectories.map((path) => <li key={path}><button type="button" className="rounded bg-raised px-1.5 py-0.5 font-code text-tiny text-muted hover:text-ink" onClick={() => saveExcludedDirectories(excludedDirectories.filter((entry) => entry !== path))}>{path} ×</button></li>)}
        </ul>}
      </div>
      <section aria-labelledby="source-control-title" className="border-b border-hairline px-4 py-3">
        <h2 id="source-control-title" className="text-title font-semibold text-ink">Source control</h2>
        <GitGroup entries={stagedEntries} label="Staged" actionLabel="Unstage" disabled={actionPending} onAction={(path) => runGitAction(`unstage:${path}`, () => api.unstageGitPaths(workspaceId, [path]))} />
        <GitGroup entries={unstagedEntries} label="Unstaged" actionLabel="Stage" disabled={actionPending} onAction={(path) => runGitAction(`stage:${path}`, () => api.stageGitPaths(workspaceId, [path]))} onDiscard={(path) => setDiscardPath(path)} />
        <form className="mt-3" onSubmit={(event) => {
          event.preventDefault();
          if (!commitMessage.trim() || stagedEntries.length === 0 || actionPending) return;
          runGitAction('commit', () => api.commitGitChanges(workspaceId, commitMessage.trim()));
        }}>
          <label htmlFor="commit-message" className="text-label font-semibold uppercase tracking-wide text-muted">Commit message</label>
          <textarea id="commit-message" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} rows={2} className="mt-1 w-full resize-y border border-edge bg-field px-2 py-1.5 text-small text-ink focus:outline-none focus:ring-2 focus:ring-accent" />
          <button type="submit" disabled={!commitMessage.trim() || stagedEntries.length === 0 || actionPending} className="mt-2 min-h-11 w-full bg-accent px-3 text-small font-semibold text-on-accent enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">Commit staged changes</button>
        </form>
      </section>
      <div role="tree" aria-label="Workspace files" className="min-h-0 flex-1 overflow-auto py-2">
        {errors[''] && <p className="px-4 text-small text-fail">{errors['']}</p>}
        {rows().map(({ entry, depth }) => {
          const { path } = entry;
          const directory = entry.type === 'directory';
          const open = !entry.excluded && expanded.has(path);
          const status = statusFor(path, directory);
          return <button key={path} type="button" role="treeitem" aria-level={depth + 1} aria-expanded={directory ? open : undefined} aria-disabled={entry.excluded || undefined} aria-selected={selectedPath === path} className={`flex min-h-8 w-full items-center gap-1.5 pr-3 text-left text-small ${entry.excluded ? 'text-muted' : selectedPath === path ? 'bg-accent-tint text-accent' : status ? `${gitFileStatusClass(status)} hover:bg-raised` : 'text-ink hover:bg-raised'}`} style={{ paddingLeft: `${0.75 + depth * 1}rem` }} onContextMenu={(event) => {
            if (!directory) return;
            event.preventDefault();
            toggleExcludedDirectory(path);
          }} onClick={() => {
            if (!directory) { onSelectFile(path); return; }
            if (entry.excluded) return;
            setExpanded((current) => {
              const next = new Set(current);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            });
            if (!listings[path]) void load(path);
          }}>
            {directory && <Icon name="chevron-down" className={open ? '' : '-rotate-90'} />}
            {!directory && <span className="w-4" />}
            <Icon name={directory ? 'files' : 'api'} />
            <span className="truncate font-code" title={path}>{entry.name}</span>
            {status && <span aria-label={`${status}${directory ? ' changes in directory' : ''}`} className={`ml-auto size-1.5 shrink-0 rounded-full ${gitFileStatusClass(status).replace('text-', 'bg-')}`} />}
          </button>;
        })}
        {Object.values(listings).filter((listing) => listing.entries.length < listing.total).map((listing) => (
          <button key={`more-${listing.path}`} className="ml-3 mt-2 block text-small text-accent" onClick={() => void load(listing.path, listing.entries.length)}>
            Load more in {listing.path || 'workspace'}
          </button>
        ))}
      </div>
    </aside>
    <section className="flex min-w-0 flex-1 flex-col bg-sunken">
      {openPaths.length > 0 && <header className="flex min-h-11 items-center gap-1 overflow-x-auto border-b border-hairline bg-shell px-2">
        {openPaths.map((path) => {
          const dirty = drafts[path]?.text !== drafts[path]?.saved;
          return <div key={path} className={`flex shrink-0 items-center rounded-sm ${path === selectedPath ? 'bg-accent-tint text-accent' : 'text-muted hover:bg-raised'}`}>
            <button type="button" className="flex items-center gap-1.5 px-2 py-1.5 font-code text-small" onClick={() => onSelectFile(path)}>
              {dirty && <span aria-label="Unsaved changes" className="size-1.5 rounded-full bg-accent" />}
              {path}
            </button>
            <button type="button" aria-label={`Close ${path}`} className="p-1.5" onClick={() => close(path)}><Icon name="close" /></button>
          </div>;
        })}
        {selectedPath && drafts[selectedPath] && <button type="button" disabled={!drafts[selectedPath] || drafts[selectedPath].text === drafts[selectedPath].saved || saving} className={`ml-auto shrink-0 ${btnPrimary}`} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>}
      </header>}
      {saveError && <p className="border-b border-hairline bg-shell px-4 py-2 text-small text-fail">{saveError}</p>}
      {fileError ? <p className="p-4 text-small text-fail">{fileError}</p> : file && selectedPath && file.isTooLarge ? <div className="p-4 text-small text-muted"><p>This file is too large to edit.</p><a href={api.workspaceRawUrl(workspaceId, selectedPath)} download={selectedPath.split('/').at(-1)} className="mt-3 inline-block text-accent hover:underline">Download</a></div> : file && selectedPath && ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mime) ? <img src={api.workspaceRawUrl(workspaceId, selectedPath)} alt={`Preview of ${selectedPath}`} className="min-h-0 max-h-full max-w-full object-contain p-4" /> : file && selectedPath && file.mime.startsWith('audio/') ? <audio controls src={api.workspaceRawUrl(workspaceId, selectedPath)} className="m-4" /> : file && selectedPath && file.isBinary ? <div className="p-4 text-small text-muted"><p>This binary file cannot be displayed.</p><a href={api.workspaceRawUrl(workspaceId, selectedPath)} download={selectedPath.split('/').at(-1)} className="mt-3 inline-block text-accent hover:underline">Download</a></div> : file && selectedPath && drafts[selectedPath] && ['.md', '.markdown'].some((extension) => selectedPath.toLowerCase().endsWith(extension)) ? <div className="flex min-h-0 flex-1 flex-col"><div className="border-b border-hairline bg-shell px-4 py-2"><button type="button" className="text-small text-accent hover:underline" onClick={() => setMarkdownPreview((current) => ({ ...current, [selectedPath]: !current[selectedPath] }))}>{markdownPreview[selectedPath] ? 'Edit' : 'Preview'}</button></div>{markdownPreview[selectedPath] ? <Markdown source={drafts[selectedPath].text} className="min-h-0 flex-1 overflow-auto p-4" /> : <CodeViewer path={selectedPath} text={drafts[selectedPath].text} onChange={(text) => setDrafts((current) => {
        const draft = current[selectedPath];
        return draft ? { ...current, [selectedPath]: { saved: draft.saved, text } } : current;
      })} onSave={save} />}</div> : file && selectedPath && drafts[selectedPath] ? <CodeViewer path={selectedPath} text={drafts[selectedPath].text} onChange={(text) => setDrafts((current) => {
        const draft = current[selectedPath];
        return draft ? { ...current, [selectedPath]: { saved: draft.saved, text } } : current;
      })} onSave={save} /> : <p className="p-4 text-small text-muted">Select a file to view it.</p>}
    </section>
    {discardPath && <ConfirmDialog
      label={`Discard ${discardPath}`}
      title="Discard changes?"
      confirmLabel="Discard changes"
      tone="danger"
      onCancel={() => setDiscardPath(null)}
      onConfirm={() => {
        const path = discardPath;
        setDiscardPath(null);
        runGitAction(`discard:${path}`, () => api.discardGitPaths(workspaceId, [path]));
      }}
    >
      This removes uncommitted changes in <code>{discardPath}</code>.
    </ConfirmDialog>}
  </div>;
}

function GitGroup({ entries, label, actionLabel, disabled, onAction, onDiscard }: {
  entries: GitStatusEntry[];
  label: string;
  actionLabel: string;
  disabled: boolean;
  onAction: (path: string) => void;
  onDiscard?: (path: string) => void;
}) {
  return <div className="mt-2">
    <div className="flex items-center justify-between text-label font-semibold uppercase tracking-wide text-muted"><span>{label}</span><span>{entries.length}</span></div>
    {entries.length === 0 ? <p className="mt-1 text-tiny text-muted">No files</p> : <ul className="mt-1 divide-y divide-hairline">
      {entries.map((entry) => <li key={`${label}-${entry.path}`} className="py-1.5">
        <p className="truncate font-code text-tiny text-ink" title={entry.path}>{entry.path}</p>
        <div className="mt-1 flex gap-1">
          <button type="button" disabled={disabled} className="min-h-11 flex-1 border border-edge px-2 text-tiny text-accent enabled:hover:bg-accent-tint disabled:opacity-50" onClick={() => onAction(entry.path)}>{actionLabel}</button>
          {onDiscard && <button type="button" disabled={disabled} className="min-h-11 border border-edge px-2 text-tiny text-fail enabled:hover:bg-fail-tint disabled:opacity-50" onClick={() => onDiscard(entry.path)}>Discard</button>}
        </div>
      </li>)}
    </ul>}
  </div>;
}

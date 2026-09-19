import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { api } from '../api';
import type { DiffFile, GitStatusEntry, Workspace, WorkspaceFile, WorkspaceFileListing } from '../types';
import { useLiveEffect } from '../useLiveEffect';
import { useAsyncResource } from '../useAsyncResource';
import { subscribe } from '../ws';
import { btnGhost, btnPrimary, gitFileStatusClass, panelTitle, type GitFileStatus } from '../ui';
import { Icon, type IconName } from './Icon';
import { CodeViewer, type CursorInfo } from './CodeViewer';
import { ConfirmDialog } from './ConfirmDialog';
import { DiffViewer } from './DiffViewer';
import { LoadError } from './LoadError';
import { Modal } from './Modal';
import { Markdown } from './Markdown';
import { errorText } from '../error-text';

const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const baseName = (path: string) => path.split('/').at(-1) ?? path;
const isMarkdownPath = (path: string) => ['.md', '.markdown'].some((extension) => path.toLowerCase().endsWith(extension));

const LANGUAGE_LABELS: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript', cjs: 'JavaScript',
  json: 'JSON', md: 'Markdown', markdown: 'Markdown', css: 'CSS', scss: 'SCSS', html: 'HTML',
  yaml: 'YAML', yml: 'YAML', xml: 'XML', sh: 'Shell', bash: 'Shell', py: 'Python', go: 'Go',
  rs: 'Rust', rb: 'Ruby', java: 'Java', sql: 'SQL', toml: 'TOML', txt: 'Plain Text',
};
const languageLabel = (path: string) => {
  const extension = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
  return LANGUAGE_LABELS[extension] ?? (extension ? extension.toUpperCase() : 'Plain Text');
};

const SIDEBAR_WIDTH_KEY = 'harmonic.files-sidebar-width';
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;
const loadSidebarWidth = () => {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return raw >= SIDEBAR_MIN && raw <= SIDEBAR_MAX ? raw : 288;
  } catch {
    return 288;
  }
};

type Draft = { saved: string; text: string };
type Panel = 'explorer' | 'scm';
type ContextTarget = { path: string; directory: boolean; excluded: boolean; x: number; y: number };
type NameIntent = { mode: 'create-file' | 'create-folder'; dir: string } | { mode: 'rename'; from: string; directory: boolean };
type DiffState = { path: string; file: DiffFile | null; loading: boolean; error: string | null };

export function FilesPage({ workspace, selectedPath, onSelectFile, onWorkspaceSaved }: { workspace: Workspace; selectedPath: string | null; onSelectFile: (path: string | null) => void; onWorkspaceSaved: (workspace: Workspace) => void }) {
  const { id: workspaceId, excludedDirectories: workspaceExcludedDirectories } = workspace;
  const workspaceGeneration = useRef(0);
  const selectedPathRef = useRef(selectedPath);
  const listingsRef = useRef<Record<string, WorkspaceFileListing>>({});
  const loadRef = useRef<(path: string, offset?: number) => Promise<void>>(() => Promise.resolve());
  const refreshStatusRef = useRef<() => void>(() => {});
  const [listings, setListings] = useState<Record<string, WorkspaceFileListing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [statusEntries, setStatusEntries] = useState<GitStatusEntry[]>([]);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [excludedDirectories, setExcludedDirectories] = useState(workspaceExcludedDirectories);
  const [commitMessage, setCommitMessage] = useState('');
  const [pendingGitAction, setPendingGitAction] = useState<string | null>(null);
  const [discardPath, setDiscardPath] = useState<string | null>(null);
  const [deletePath, setDeletePath] = useState<{ path: string; directory: boolean } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [markdownPreview, setMarkdownPreview] = useState<Record<string, boolean>>({});
  const [panel, setPanel] = useState<Panel>('explorer');
  const [context, setContext] = useState<ContextTarget | null>(null);
  const [nameIntent, setNameIntent] = useState<NameIntent | null>(null);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [closingPath, setClosingPath] = useState<string | null>(null);
  const [discardAllOpen, setDiscardAllOpen] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [commitDone, setCommitDone] = useState(false);
  const [staleFile, setStaleFile] = useState<'changed' | 'deleted' | null>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const treeRef = useRef<HTMLDivElement>(null);
  const draftsRef = useRef<Record<string, Draft>>(drafts);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);
  useEffect(() => { draftsRef.current = drafts; }, [drafts]);

  useLayoutEffect(() => { workspaceGeneration.current += 1; }, [workspaceId]);
  useEffect(() => { selectedPathRef.current = selectedPath; setCursor(null); setStaleFile(null); }, [selectedPath]);
  useLayoutEffect(() => { listingsRef.current = listings; }, [listings]);

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

  const status = useAsyncResource(() => api.gitStatus(workspaceId), [workspaceId]);
  useEffect(() => { setStatusEntries(status.data ? status.data.entries : []); }, [status.data]);
  useLayoutEffect(() => {
    loadRef.current = load;
    refreshStatusRef.current = status.reload;
  });

  useLiveEffect((live) => subscribe((message) => {
    if (!live() || (message.type !== 'fs_changed' && message.type !== 'git_status') || message.workspaceId !== workspaceId) return;
    if (message.type === 'fs_changed') {
      // Coalesce a burst of writes (an agent editing files) into one reload.
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = setTimeout(() => {
        reloadTimerRef.current = null;
        for (const path of Object.keys(listingsRef.current)) void loadRef.current(path);
      }, 250);
      const open = selectedPathRef.current;
      if (open) {
        api.workspaceFile(workspaceId, open).then((next) => {
          if (selectedPathRef.current !== open) return;
          const saved = draftsRef.current[open]?.saved;
          if (next.text !== null && saved !== undefined && next.text !== saved) setStaleFile('changed');
        }, () => { if (selectedPathRef.current === open) setStaleFile('deleted'); });
      }
    }
    if (message.type === 'git_status') setStatusEntries(message.entries);
  }, () => {
    for (const path of Object.keys(listingsRef.current)) void loadRef.current(path);
    void refreshStatusRef.current();
  }), [workspaceId]);

  useLiveEffect((live) => {
    setListings({}); setExpanded(new Set()); setErrors({}); setDrafts({}); setOpenPaths([]); setSaveError(null); setMarkdownPreview({});
    api.workspaceFiles(workspaceId).then((listing) => live() && setListings({ '': listing }), (error) => live() && setErrors({ '': errorText(error) }));
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
    void api.saveWorkspaceFile(workspaceId, path, draft.text).then((saved) => {
      if (workspaceGeneration.current !== generation) return;
      const text = saved.text ?? draft.text;
      setDrafts((current) => {
        const latest = current[path];
        return latest ? { ...current, [path]: { saved: text, text: latest.text } } : current;
      });
      if (selectedPathRef.current === path) { setFile(saved); setStaleFile(null); }
      status.reload();
    }).catch((error) => {
      if (workspaceGeneration.current === generation && selectedPathRef.current === path) setSaveError(errorText(error));
    }).finally(() => setSaving(false));
  };

  const performClose = (path: string) => {
    const remaining = openPaths.filter((openPath) => openPath !== path);
    setOpenPaths(remaining);
    setDrafts((current) => { const { [path]: _, ...rest } = current; return rest; });
    if (selectedPath === path) selectFile(remaining.at(-1) ?? null);
  };

  const close = (path: string) => {
    const draft = drafts[path];
    if (draft && draft.text !== draft.saved) { setClosingPath(path); return; }
    performClose(path);
  };

  const reloadOpenFile = () => {
    const path = selectedPath;
    if (!path) return;
    setStaleFile(null);
    api.workspaceFile(workspaceId, path).then((next) => {
      if (selectedPathRef.current !== path) return;
      setFile(next); setFileError(null);
      if (next.text !== null) setDrafts((current) => ({ ...current, [path]: { saved: next.text as string, text: next.text as string } }));
    }, (error) => { if (selectedPathRef.current === path) setFileError(errorText(error)); });
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
    }, (error) => setOpError(`Couldn't update excluded folders: ${errorText(error)}`));
  };

  const toggleExcludedDirectory = (path: string) => {
    saveExcludedDirectories(excludedDirectories.includes(path)
      ? excludedDirectories.filter((entry) => entry !== path)
      : [...excludedDirectories, path]);
  };

  const selectFile = (path: string | null) => {
    setDiff(null);
    onSelectFile(path);
  };

  const openRelative = (from: string, href: string) => {
    const cleaned = href.split(/[?#]/)[0];
    if (!cleaned) return;
    const segments = (parentOf(from) ? parentOf(from).split('/') : []).concat(cleaned.split('/'));
    const stack: string[] = [];
    for (const part of segments) {
      if (part === '' || part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    const target = stack.join('/');
    if (target) selectFile(target);
  };

  const openDiff = (path: string) => {
    setDiff({ path, file: null, loading: true, error: null });
    const generation = workspaceGeneration.current;
    api.gitFileDiff(workspaceId, path).then(({ file }) => {
      if (workspaceGeneration.current === generation) setDiff((current) => current?.path === path ? { path, file, loading: false, error: null } : current);
    }, (error) => {
      if (workspaceGeneration.current === generation) setDiff((current) => current?.path === path ? { path, file: null, loading: false, error: errorText(error) } : current);
    });
  };

  const startResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidthRef.current;
    setResizing(true);
    const move = (ev: PointerEvent) => setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX)));
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current)); } catch {}
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const nudgeResize = (delta: number) => {
    setSidebarWidth((width) => {
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width + delta));
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next)); } catch {}
      return next;
    });
  };

  const setExpandedFor = (path: string, open: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(path); else next.delete(path);
      return next;
    });
    if (open && !listings[path]) void load(path);
  };

  const activateRow = (entry: WorkspaceFileListing['entries'][number]) => {
    if (entry.type !== 'directory') { selectFile(entry.path); setFocusedPath(entry.path); return; }
    if (entry.excluded) return;
    setExpandedFor(entry.path, !expanded.has(entry.path));
  };

  const focusTreeItem = (path: string) => {
    setFocusedPath(path);
    requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[data-treepath="${CSS.escape(path)}"]`)?.focus());
  };

  const openContextAt = (entry: WorkspaceFileListing['entries'][number], node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    setContext({ path: entry.path, directory: entry.type === 'directory', excluded: entry.excluded, x: rect.left + 12, y: rect.bottom });
  };

  const closeContext = () => {
    const path = context?.path;
    setContext(null);
    if (path) focusTreeItem(path);
  };

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const active = document.activeElement as HTMLElement | null;
    const path = active?.getAttribute('data-treepath');
    if (!path) return;
    const visible = rows();
    const paths = visible.map((row) => row.entry.path);
    const idx = paths.indexOf(path);
    const row = visible[idx];
    if (idx < 0 || !row) return;
    const directory = row.entry.type === 'directory';
    const open = directory && !row.entry.excluded && expanded.has(path);
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); if (idx < paths.length - 1) focusTreeItem(paths[idx + 1]!); break;
      case 'ArrowUp': event.preventDefault(); if (idx > 0) focusTreeItem(paths[idx - 1]!); break;
      case 'Home': event.preventDefault(); if (paths[0]) focusTreeItem(paths[0]); break;
      case 'End': event.preventDefault(); if (paths.length) focusTreeItem(paths[paths.length - 1]!); break;
      case 'ArrowRight': event.preventDefault(); if (directory && !row.entry.excluded) { if (!open) setExpandedFor(path, true); else if (idx < paths.length - 1) focusTreeItem(paths[idx + 1]!); } break;
      case 'ArrowLeft': event.preventDefault(); if (open) setExpandedFor(path, false); else { const parent = parentOf(path); if (parent && paths.includes(parent)) focusTreeItem(parent); } break;
      case 'Enter': case ' ': event.preventDefault(); activateRow(row.entry); break;
      case 'ContextMenu': event.preventDefault(); if (active) openContextAt(row.entry, active); break;
      case 'F10': if (event.shiftKey && active) { event.preventDefault(); openContextAt(row.entry, active); } break;
    }
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
    setOpError(null);
    work().then(() => {
      status.reload();
      if (action === 'commit') {
        setCommitMessage('');
        setCommitDone(true);
        setTimeout(() => setCommitDone(false), 2500);
      }
    }).catch((error: unknown) => setOpError(`Git action failed: ${errorText(error)}`)).finally(() => setPendingGitAction(null));
  };

  const reloadAfterMutation = (...dirs: string[]) => {
    for (const dir of new Set(dirs)) if (listings[dir] !== undefined || dir === '') void load(dir);
    status.reload();
  };

  const submitName = (value: string) => {
    if (!nameIntent) return;
    const name = value.trim();
    if (!name) return;
    if (nameIntent.mode === 'rename') {
      const from = nameIntent.from;
      const parent = parentOf(from);
      const to = name.includes('/') ? name : parent ? `${parent}/${name}` : name;
      if (to === from) { setNameIntent(null); return; }
      api.moveWorkspaceEntry(workspaceId, from, to).then(() => {
        setExpanded((current) => { const next = new Set(current); if (nameIntent.directory) { next.delete(from); } return next; });
        renameOpenPaths(from, to, nameIntent.directory);
        reloadAfterMutation('', parentOf(from), parentOf(to));
        setNameIntent(null);
      }, (error) => setNameIntent((current) => current && { ...current, error: errorText(error) } as NameIntent & { error: string }));
      return;
    }
    const dir = nameIntent.dir;
    const path = dir ? `${dir}/${name}` : name;
    const type = nameIntent.mode === 'create-folder' ? 'directory' : 'file';
    api.createWorkspaceEntry(workspaceId, path, type).then((entry) => {
      if (dir) setExpanded((current) => new Set(current).add(dir));
      reloadAfterMutation('', dir);
      setNameIntent(null);
      if (entry.type === 'file') onSelectFile(entry.path);
    }, (error) => setNameIntent((current) => current && { ...current, error: errorText(error) } as NameIntent & { error: string }));
  };

  const renameOpenPaths = (from: string, to: string, directory: boolean) => {
    const remap = (p: string) => p === from ? to : directory && p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : null;
    setOpenPaths((current) => current.map((p) => remap(p) ?? p));
    setDrafts((current) => {
      const next: Record<string, Draft> = {};
      for (const [p, draft] of Object.entries(current)) next[remap(p) ?? p] = draft;
      return next;
    });
    if (selectedPath) { const mapped = remap(selectedPath); if (mapped) onSelectFile(mapped); }
  };

  const removeOpenPaths = (path: string, directory: boolean) => {
    const affected = (p: string) => p === path || (directory && p.startsWith(`${path}/`));
    const remaining = openPaths.filter((p) => !affected(p));
    setOpenPaths(remaining);
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([p]) => !affected(p))));
    if (selectedPath && affected(selectedPath)) onSelectFile(remaining.at(-1) ?? null);
  };

  const confirmDelete = () => {
    if (!deletePath) return;
    const { path, directory } = deletePath;
    setDeletePath(null);
    api.deleteWorkspaceEntry(workspaceId, path).then(() => {
      setExpanded((current) => { const next = new Set(current); next.delete(path); return next; });
      removeOpenPaths(path, directory);
      reloadAfterMutation('', parentOf(path));
    }, (error) => setOpError(`Couldn't delete ${path}: ${errorText(error)}`));
  };

  const stagedEntries = statusEntries.filter((entry) => entry.indexStatus !== '.' && entry.indexStatus !== '?');
  const unstagedEntries = statusEntries.filter((entry) => entry.worktreeStatus !== '.' || entry.indexStatus === '?');
  const actionPending = pendingGitAction !== null;
  const changeCount = statusEntries.length;
  const codeVisible = !diff && !fileError && !!file && selectedPath !== null && !!drafts[selectedPath]
    && !file.isTooLarge && !file.isBinary && !file.mime.startsWith('audio/')
    && !['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mime)
    && !(isMarkdownPath(selectedPath) && markdownPreview[selectedPath]);
  const visibleRows = rows();
  const rovingPath = focusedPath && visibleRows.some((row) => row.entry.path === focusedPath) ? focusedPath : visibleRows[0]?.entry.path ?? null;

  return <div className={`flex h-full min-h-0 min-w-0 border-t border-hairline ${resizing ? 'cursor-col-resize select-none' : ''}`} onClick={() => context && closeContext()} onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
  }}>
    <nav aria-label="Files panels" className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-hairline bg-shell pt-1.5">
      <ActivityButton icon="files" label="Explorer" active={panel === 'explorer'} onClick={() => setPanel('explorer')} />
      <ActivityButton icon="branch" label="Source control" active={panel === 'scm'} onClick={() => setPanel('scm')} badge={changeCount} />
    </nav>

    <aside className="flex shrink-0 flex-col bg-shell max-md:max-w-[50vw]" style={{ width: sidebarWidth }}>
      {panel === 'explorer' ? <>
        <div className="flex h-9 items-center gap-1 border-b border-hairline pl-3 pr-1.5">
          <span className="text-label font-semibold uppercase tracking-wide text-muted">Explorer</span>
          <span className="min-w-0 flex-1 truncate font-code text-tiny text-faint" title={workspace.name}>{workspace.name}</span>
          <IconButton icon="file-plus" title="New file" onClick={() => setNameIntent({ mode: 'create-file', dir: '' })} />
          <IconButton icon="folder-plus" title="New folder" onClick={() => setNameIntent({ mode: 'create-folder', dir: '' })} />
          <IconButton icon="collapse" title="Collapse folders" onClick={() => setExpanded(new Set())} />
        </div>
        <div role="tree" aria-label="Workspace files" ref={treeRef} onKeyDown={onTreeKeyDown} className="min-h-0 flex-1 overflow-auto py-1">
          {errors[''] && <p className="px-3 py-2 text-small text-fail">{errors['']}</p>}
          {visibleRows.length === 0 && !errors[''] && <p className="px-3 py-2 text-small text-muted">This workspace is empty.</p>}
          {visibleRows.map(({ entry, depth }) => {
            const { path } = entry;
            const directory = entry.type === 'directory';
            const open = !entry.excluded && expanded.has(path);
            const status = statusFor(path, directory);
            return <button key={path} type="button" role="treeitem" data-treepath={path} tabIndex={rovingPath === path ? 0 : -1} aria-level={depth + 1} aria-expanded={directory ? open : undefined} aria-disabled={entry.excluded || undefined} aria-selected={selectedPath === path} className={`flex min-h-7 w-full items-center gap-1.5 pr-2.5 text-left text-small outline-none focus-visible:bg-raised ${entry.excluded ? 'text-faint' : selectedPath === path ? 'bg-accent-tint text-accent' : status ? `${gitFileStatusClass(status)} hover:bg-raised` : 'text-ink hover:bg-raised'}`} style={{ paddingLeft: `${0.5 + depth * 0.875}rem` }} onContextMenu={(event) => {
              event.preventDefault();
              setFocusedPath(path);
              setContext({ path, directory, excluded: entry.excluded, x: event.clientX, y: event.clientY });
            }} onClick={() => {
              setFocusedPath(path);
              if (!directory) { selectFile(path); return; }
              if (entry.excluded) return;
              setExpandedFor(path, !expanded.has(path));
            }}>
              {directory ? <Icon name="chevron-down" className={`shrink-0 text-faint ${open ? '' : '-rotate-90'}`} /> : <span className="w-4 shrink-0" />}
              <Icon name={directory ? 'files' : 'file'} className="shrink-0 text-faint" />
              <span className="truncate font-code" title={path}>{entry.name}</span>
              {entry.excluded && <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-faint">excluded</span>}
              {status && !entry.excluded && <span aria-label={`${status}${directory ? ' changes in directory' : ''}`} className={`ml-auto size-1.5 shrink-0 rounded-full ${gitFileStatusClass(status).replace('text-', 'bg-')}`} />}
            </button>;
          })}
          {Object.values(listings).filter((listing) => listing.entries.length < listing.total).map((listing) => (
            <button key={`more-${listing.path}`} type="button" className="ml-3 mt-1 block text-small text-accent hover:underline" onClick={() => void load(listing.path, listing.entries.length)}>
              Load more in {listing.path || 'workspace'}
            </button>
          ))}
        </div>
      </> : <>
        <div className="flex h-9 items-center gap-1 border-b border-hairline pl-3 pr-1.5">
          <h2 id="source-control-title" className="text-label font-semibold uppercase tracking-wide text-muted">Source control</h2>
          <span className={`min-w-0 flex-1 truncate text-tiny ${commitDone ? 'text-merged' : 'text-faint'}`} aria-live="polite">{commitDone ? 'Committed' : changeCount === 0 ? 'No changes' : `${changeCount} changed`}</span>
          <IconButton icon="refresh" title="Refresh status" onClick={() => status.reload()} />
        </div>
        <section aria-labelledby="source-control-title" className="min-h-0 flex-1 overflow-auto">
          <form className="border-b border-hairline p-3" onSubmit={(event) => {
            event.preventDefault();
            if (!commitMessage.trim() || stagedEntries.length === 0 || actionPending) return;
            runGitAction('commit', () => api.commitGitChanges(workspaceId, commitMessage.trim()));
          }}>
            <label htmlFor="commit-message" className="text-label font-semibold uppercase tracking-wide text-muted">Commit message</label>
            <textarea id="commit-message" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} rows={2} placeholder="Message" className="mt-1 w-full resize-y border border-edge bg-field px-2 py-1.5 text-small text-ink focus:outline-none focus:ring-2 focus:ring-accent" />
            <button type="submit" disabled={!commitMessage.trim() || stagedEntries.length === 0 || actionPending} className="mt-2 min-h-11 w-full bg-accent px-3 text-small font-semibold text-on-accent enabled:hover:bg-accent-hot disabled:cursor-not-allowed disabled:opacity-50">Commit {stagedEntries.length} staged</button>
          </form>
          <GitGroup entries={stagedEntries} label="Staged" actionIcon="collapse" actionLabel="Unstage" activePath={diff?.path ?? null} disabled={actionPending} onOpen={openDiff} onAction={(path) => runGitAction(`unstage:${path}`, () => api.unstageGitPaths(workspaceId, [path]))} onActionAll={() => runGitAction('unstage-all', () => api.unstageGitPaths(workspaceId, stagedEntries.map((entry) => entry.path)))} />
          <GitGroup entries={unstagedEntries} label="Changes" actionIcon="plus" actionLabel="Stage" activePath={diff?.path ?? null} disabled={actionPending} onOpen={openDiff} onAction={(path) => runGitAction(`stage:${path}`, () => api.stageGitPaths(workspaceId, [path]))} onActionAll={() => runGitAction('stage-all', () => api.stageGitPaths(workspaceId, unstagedEntries.map((entry) => entry.path)))} onDiscard={(path) => setDiscardPath(path)} onDiscardAll={() => setDiscardAllOpen(true)} />
          {status.error ? <LoadError message={status.error} onRetry={status.reload} className="m-3" /> : changeCount === 0 && <p className="px-3 py-3 text-small text-muted">The working tree is clean.</p>}
        </section>
      </>}
    </aside>

    <div role="separator" aria-orientation="vertical" aria-label="Resize explorer" tabIndex={0} onPointerDown={startResize} onKeyDown={(event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); nudgeResize(-16); }
      if (event.key === 'ArrowRight') { event.preventDefault(); nudgeResize(16); }
    }} className="group relative w-px shrink-0 cursor-col-resize bg-hairline focus:outline-none">
      <span aria-hidden="true" className={`absolute inset-y-0 -left-1 -right-1 transition-colors ${resizing ? 'bg-accent/40' : 'group-hover:bg-accent/30 group-focus-visible:bg-accent/40'}`} />
    </div>

    <section className="flex min-w-0 flex-1 flex-col bg-sunken">
      {opError && <div className="flex items-start gap-2 border-b border-hairline bg-fail-tint px-3 py-2 text-small text-fail" role="alert">
        <span className="min-w-0 flex-1">{opError}</span>
        <button type="button" aria-label="Dismiss error" className="shrink-0 hover:text-ink" onClick={() => setOpError(null)}><Icon name="close" /></button>
      </div>}
      {diff ? <>
        <div className="flex min-h-9 items-center gap-2 border-b border-hairline bg-shell px-3">
          <Icon name="branch" className="shrink-0 text-tool" />
          <span className="min-w-0 flex-1 truncate font-code text-small text-ink" title={diff.path}>{diff.path}</span>
          <button type="button" aria-label="Close diff" title="Close diff" className="flex size-7 items-center justify-center rounded-sm text-faint hover:bg-raised hover:text-ink" onClick={() => setDiff(null)}><Icon name="close" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {diff.loading ? <p className="p-4 text-small text-muted">Loading diff…</p> : diff.error ? <p className="p-4 text-small text-fail">{diff.error}</p> : diff.file ? <DiffViewer file={diff.file} headerless /> : <p className="p-4 text-small text-muted">No textual changes to show for this file.</p>}
        </div>
      </> : <>
        {openPaths.length > 0 && <header className="flex min-h-9 items-stretch overflow-x-auto border-b border-hairline bg-shell">
          {openPaths.map((path) => {
            const dirty = drafts[path]?.text !== drafts[path]?.saved;
            const activeTab = path === selectedPath;
            return <div key={path} className={`flex shrink-0 items-center border-r border-hairline ${activeTab ? 'bg-sunken text-ink' : 'text-muted hover:bg-raised'}`}>
              <button type="button" className="flex items-center gap-1.5 py-2 pl-3 pr-1.5 font-code text-small" onClick={() => selectFile(path)} title={path}>
                <Icon name="file" className="shrink-0 text-faint" />
                {baseName(path)}
                {dirty && <span aria-label="Unsaved changes" className="size-1.5 rounded-full bg-accent" />}
              </button>
              <button type="button" aria-label={`Close ${path}`} className="p-1.5 text-faint hover:text-ink" onClick={() => close(path)}><Icon name="close" /></button>
            </div>;
          })}
        </header>}
        {selectedPath && drafts[selectedPath] && <div className="flex min-h-8 items-center gap-1 border-b border-hairline bg-shell px-3">
          <span className="min-w-0 flex-1 truncate font-code text-tiny text-faint" title={selectedPath}>{selectedPath}</span>
          {['.md', '.markdown'].some((extension) => selectedPath.toLowerCase().endsWith(extension)) && <button type="button" aria-label={markdownPreview[selectedPath] ? 'Edit source' : 'Preview'} title={markdownPreview[selectedPath] ? 'Edit source' : 'Preview'} className="flex size-7 items-center justify-center rounded-sm text-faint hover:bg-raised hover:text-ink" onClick={() => setMarkdownPreview((current) => ({ ...current, [selectedPath]: !current[selectedPath] }))}><Icon name={markdownPreview[selectedPath] ? 'edit' : 'eye'} /></button>}
          <button type="button" aria-label="Save file" title="Save (⌘S)" disabled={drafts[selectedPath].text === drafts[selectedPath].saved || saving} className="flex size-7 items-center justify-center rounded-sm text-accent hover:bg-accent-tint disabled:text-faint disabled:hover:bg-transparent" onClick={save}><Icon name="save" /></button>
        </div>}
        {saveError && <p className="border-b border-hairline bg-shell px-4 py-2 text-small text-fail">{saveError}</p>}
        {staleFile && selectedPath && <div className="flex items-center gap-3 border-b border-hairline bg-running-tint px-3 py-2 text-small text-running" role="status">
          <span className="min-w-0 flex-1">{staleFile === 'deleted' ? 'This file was deleted on disk — saving will recreate it.' : 'This file changed on disk since you opened it.'}</span>
          {staleFile === 'changed' && <button type="button" className="shrink-0 rounded-sm border border-edge px-2 py-0.5 font-semibold text-ink hover:bg-surface" onClick={reloadOpenFile}>Reload</button>}
          <button type="button" aria-label="Dismiss" className="shrink-0 hover:text-ink" onClick={() => setStaleFile(null)}><Icon name="close" /></button>
        </div>}
        {fileError ? <p className="p-4 text-small text-fail">{fileError}</p> : file && selectedPath && file.isTooLarge ? <div className="p-4 text-small text-muted"><p>This file is too large to edit.</p><a href={api.workspaceRawUrl(workspaceId, selectedPath)} download={selectedPath.split('/').at(-1)} className="mt-3 inline-block text-accent hover:underline">Download</a></div> : file && selectedPath && ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mime) ? <img src={api.workspaceRawUrl(workspaceId, selectedPath)} alt={`Preview of ${selectedPath}`} className="min-h-0 max-h-full max-w-full object-contain p-4" /> : file && selectedPath && file.mime.startsWith('audio/') ? <audio controls src={api.workspaceRawUrl(workspaceId, selectedPath)} className="m-4" /> : file && selectedPath && file.isBinary ? <div className="p-4 text-small text-muted"><p>This binary file cannot be displayed.</p><a href={api.workspaceRawUrl(workspaceId, selectedPath)} download={selectedPath.split('/').at(-1)} className="mt-3 inline-block text-accent hover:underline">Download</a></div> : file && selectedPath && drafts[selectedPath] && markdownPreview[selectedPath] && ['.md', '.markdown'].some((extension) => selectedPath.toLowerCase().endsWith(extension)) ? <Markdown source={drafts[selectedPath].text} className="markdown-doc min-h-0 flex-1 overflow-auto p-6" onFileLink={(href) => openRelative(selectedPath, href)} /> : file && selectedPath && drafts[selectedPath] ? <CodeViewer path={selectedPath} text={drafts[selectedPath].text} onChange={(text) => setDrafts((current) => {
          const draft = current[selectedPath];
          return draft ? { ...current, [selectedPath]: { saved: draft.saved, text } } : current;
        })} onSave={save} onCursor={setCursor} /> : <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-small text-faint"><Icon name="files" className="size-6 opacity-60" /><p>Select a file to view or edit it.</p></div>}
        {codeVisible && selectedPath && <footer className="flex min-h-6 shrink-0 items-center gap-4 border-t border-hairline bg-shell pl-3 pr-3 text-tiny text-faint md:pr-40">
          <span className="tabular-nums">Ln {cursor?.line ?? 1}, Col {cursor?.col ?? 1}</span>
          {cursor && cursor.selection > 0 && <span className="tabular-nums">{cursor.selection} selected</span>}
          <span className="ml-auto text-muted">{languageLabel(selectedPath)}</span>
        </footer>}
      </>}
    </section>

    {context && <ContextMenu target={context} onClose={closeContext}
      onNewFile={(dir) => setNameIntent({ mode: 'create-file', dir })}
      onNewFolder={(dir) => setNameIntent({ mode: 'create-folder', dir })}
      onRename={(path, directory) => setNameIntent({ mode: 'rename', from: path, directory })}
      onDelete={(path, directory) => setDeletePath({ path, directory })}
      onToggleExclude={toggleExcludedDirectory}
    />}

    {nameIntent && <NameDialog intent={nameIntent} onCancel={() => setNameIntent(null)} onSubmit={submitName} />}

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

    {deletePath && <ConfirmDialog
      label={`Delete ${deletePath.path}`}
      title={deletePath.directory ? 'Delete this folder?' : 'Delete this file?'}
      confirmLabel="Delete"
      tone="danger"
      onCancel={() => setDeletePath(null)}
      onConfirm={confirmDelete}
    >
      {deletePath.directory ? <>This permanently deletes <code>{deletePath.path}</code> and everything inside it.</> : <>This permanently deletes <code>{deletePath.path}</code>.</>}
    </ConfirmDialog>}

    {closingPath && <ConfirmDialog
      label={`Close ${closingPath}`}
      title="Discard unsaved changes?"
      confirmLabel="Discard & close"
      tone="danger"
      onCancel={() => setClosingPath(null)}
      onConfirm={() => { const path = closingPath; setClosingPath(null); performClose(path); }}
    >
      <code>{closingPath}</code> has unsaved changes that will be lost.
    </ConfirmDialog>}

    {discardAllOpen && <ConfirmDialog
      label="Discard all changes"
      title="Discard all changes?"
      confirmLabel="Discard all"
      tone="danger"
      onCancel={() => setDiscardAllOpen(false)}
      onConfirm={() => { setDiscardAllOpen(false); runGitAction('discard-all', () => api.discardGitPaths(workspaceId, unstagedEntries.map((entry) => entry.path))); }}
    >
      This permanently discards uncommitted changes in all {unstagedEntries.length} changed {unstagedEntries.length === 1 ? 'file' : 'files'}.
    </ConfirmDialog>}
  </div>;
}

function ActivityButton({ icon, label, active, onClick, badge }: { icon: IconName; label: string; active: boolean; onClick: () => void; badge?: number }) {
  return <button type="button" title={label} aria-label={label} aria-pressed={active} onClick={onClick} className={`relative flex size-10 items-center justify-center rounded-sm ${active ? 'text-accent' : 'text-faint hover:bg-raised hover:text-ink'}`}>
    {active && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />}
    <Icon name={icon} className="size-5" />
    {badge !== undefined && badge > 0 && <span className="absolute right-1 top-1 min-w-4 rounded-full bg-edge px-1 text-[9px] font-semibold leading-4 text-ink">{badge}</span>}
  </button>;
}

function IconButton({ icon, title, onClick }: { icon: IconName; title: string; onClick: () => void }) {
  return <button type="button" title={title} aria-label={title} onClick={onClick} className="flex size-7 items-center justify-center rounded-sm text-faint hover:bg-raised hover:text-ink">
    <Icon name={icon} />
  </button>;
}

function ContextMenu({ target, onClose, onNewFile, onNewFolder, onRename, onDelete, onToggleExclude }: {
  target: ContextTarget;
  onClose: () => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (path: string, directory: boolean) => void;
  onDelete: (path: string, directory: boolean) => void;
  onToggleExclude: (path: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }, []);
  const moveFocus = (to: 1 | -1 | 'first' | 'last') => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = to === 'first' ? 0 : to === 'last' ? items.length - 1 : (current + to + items.length) % items.length;
    items[next]?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(-1); }
    else if (event.key === 'Home') { event.preventDefault(); moveFocus('first'); }
    else if (event.key === 'End') { event.preventDefault(); moveFocus('last'); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  };
  const item = (label: string, icon: IconName, run: () => void, danger = false) => <button type="button" role="menuitem" className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-small outline-none focus-visible:bg-raised ${danger ? 'text-fail hover:bg-fail-tint focus-visible:bg-fail-tint' : 'text-ink hover:bg-raised'}`} onClick={() => { run(); onClose(); }}><Icon name={icon} className="shrink-0 text-faint" />{label}</button>;
  return <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }}>
    <div ref={menuRef} role="menu" aria-label="File actions" onKeyDown={onKeyDown} className="absolute min-w-44 border border-edge bg-surface py-1 shadow-float outline-none" style={{ top: target.y, left: target.x }} onClick={(event) => event.stopPropagation()}>
      {target.directory && <>
        {item('New file', 'file-plus', () => onNewFile(target.path))}
        {item('New folder', 'folder-plus', () => onNewFolder(target.path))}
        <div className="my-1 border-t border-hairline" />
      </>}
      {item('Rename…', 'edit', () => onRename(target.path, target.directory))}
      {item('Delete…', 'trash', () => onDelete(target.path, target.directory), true)}
      {target.directory && <>
        <div className="my-1 border-t border-hairline" />
        {item(target.excluded ? 'Include in tree' : 'Exclude from tree', target.excluded ? 'check' : 'close', () => onToggleExclude(target.path))}
      </>}
    </div>
  </div>;
}

function NameDialog({ intent, onCancel, onSubmit }: { intent: NameIntent & { error?: string }; onCancel: () => void; onSubmit: (value: string) => void }) {
  const rename = intent.mode === 'rename';
  const renamePrefix = rename && parentOf(intent.from) ? `${parentOf(intent.from)}/` : '';
  const [value, setValue] = useState(rename ? baseName(intent.from) : '');
  const title = rename ? (intent.directory ? 'Rename folder' : 'Rename file') : intent.mode === 'create-folder' ? 'New folder' : 'New file';
  const dir = !rename ? intent.dir : '';
  const help = rename ? 'Rename it, or type a path to move it.' : dir ? `Created in ${dir}/` : 'Created at the workspace root.';
  return <Modal label={title} onClose={onCancel} className="max-w-md">
    <form className="p-5" onSubmit={(event) => { event.preventDefault(); onSubmit(value); }}>
      <h2 className={`${panelTitle} mb-1 pr-6`}>{title}</h2>
      <p className="mb-3 text-small text-muted">{help}</p>
      <div className="flex items-stretch border border-edge bg-field focus-within:ring-2 focus-within:ring-accent">
        {renamePrefix && <span className="flex shrink-0 items-center pl-2.5 font-code text-small text-faint">{renamePrefix}</span>}
        <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} aria-label={title} placeholder={rename ? 'name' : 'name'} className={`min-w-0 flex-1 bg-transparent py-2 font-code text-small text-ink focus:outline-none ${renamePrefix ? 'pr-2.5' : 'px-2.5'}`} />
      </div>
      {intent.error && <p className="mt-2 text-small text-fail">{intent.error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={`${btnGhost} px-3 py-1.5`} onClick={onCancel}>Cancel</button>
        <button type="submit" disabled={!value.trim()} className={`${btnPrimary} px-3 py-1.5`}>{rename ? 'Rename' : 'Create'}</button>
      </div>
    </form>
  </Modal>;
}

function GitGroup({ entries, label, actionIcon, actionLabel, activePath, disabled, onOpen, onAction, onActionAll, onDiscard, onDiscardAll }: {
  entries: GitStatusEntry[];
  label: string;
  actionIcon: IconName;
  actionLabel: string;
  activePath: string | null;
  disabled: boolean;
  onOpen: (path: string) => void;
  onAction: (path: string) => void;
  onActionAll?: () => void;
  onDiscard?: (path: string) => void;
  onDiscardAll?: () => void;
}) {
  if (entries.length === 0) return null;
  return <div className="py-1">
    <div className="flex items-center gap-1 px-3 py-1 text-label font-semibold uppercase tracking-wide text-muted">
      <span>{label}</span>
      <span className="text-faint">{entries.length}</span>
      <span className="flex-1" />
      {onDiscardAll && <button type="button" disabled={disabled} title="Discard all" aria-label="Discard all changes" className="flex size-6 items-center justify-center rounded-sm text-faint hover:text-fail disabled:opacity-50" onClick={onDiscardAll}><Icon name="undo" /></button>}
      {onActionAll && <button type="button" disabled={disabled} title={`${actionLabel} all`} aria-label={`${actionLabel} all`} className="flex size-6 items-center justify-center rounded-sm text-faint hover:text-accent disabled:opacity-50" onClick={onActionAll}><Icon name={actionIcon} /></button>}
    </div>
    <ul>
      {entries.map((entry) => <li key={`${label}-${entry.path}`} className={`group flex min-h-8 items-center gap-1 px-1.5 ${entry.path === activePath ? 'bg-accent-tint' : 'hover:bg-raised'}`}>
        <button type="button" className="flex min-w-0 flex-1 items-center py-1 pl-1.5 text-left" onClick={() => onOpen(entry.path)} title={entry.path}>
          <span className="truncate font-code text-tiny text-ink">{baseName(entry.path)}</span>
          <span className="ml-1.5 truncate font-code text-[10px] text-faint">{parentOf(entry.path)}</span>
        </button>
        <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          {onDiscard && <button type="button" disabled={disabled} title="Discard" aria-label={`Discard ${entry.path}`} className="flex size-7 items-center justify-center rounded-sm text-faint hover:text-fail disabled:opacity-50" onClick={() => onDiscard(entry.path)}><Icon name="undo" /></button>}
          <button type="button" disabled={disabled} title={actionLabel} aria-label={`${actionLabel} ${entry.path}`} className="flex size-7 items-center justify-center rounded-sm text-faint hover:text-accent disabled:opacity-50" onClick={() => onAction(entry.path)}><Icon name={actionIcon} /></button>
        </span>
      </li>)}
    </ul>
  </div>;
}

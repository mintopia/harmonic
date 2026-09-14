import { useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { GitStatusEntry, WorkspaceFile, WorkspaceFileListing } from '../types';
import { useLiveEffect } from '../useLiveEffect';
import { displayTitle, gitFileStatusClass, type GitFileStatus } from '../ui';
import { Icon } from './Icon';
import { CodeViewer } from './CodeViewer';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function FilesPage({ workspaceId, selectedPath, onSelectFile }: { workspaceId: number; selectedPath: string | null; onSelectFile: (path: string) => void }) {
  const workspaceGeneration = useRef(0);
  const [listings, setListings] = useState<Record<string, WorkspaceFileListing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [statusEntries, setStatusEntries] = useState<GitStatusEntry[]>([]);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useLayoutEffect(() => { workspaceGeneration.current += 1; }, [workspaceId]);

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

  useLiveEffect((live) => {
    setListings({}); setExpanded(new Set()); setErrors({}); setStatusEntries([]);
    api.workspaceFiles(workspaceId).then((listing) => live() && setListings({ '': listing }), (error) => live() && setErrors({ '': errorText(error) }));
    api.gitStatus(workspaceId).then(({ entries }) => live() && setStatusEntries(entries), () => live() && setStatusEntries([]));
  }, [workspaceId]);

  useLiveEffect((live) => {
    if (!selectedPath) { setFile(null); setFileError(null); return; }
    setFile(null); setFileError(null);
    api.workspaceFile(workspaceId, selectedPath).then((next) => live() && setFile(next), (error) => live() && setFileError(errorText(error)));
  }, [workspaceId, selectedPath]);

  const rows = (path = '', depth = 0): Array<{ entry: WorkspaceFileListing['entries'][number]; depth: number }> => {
    const listing = listings[path];
    if (!listing) return [];
    return listing.entries.flatMap((entry) => [{ entry, depth }, ...(entry.type === 'directory' && expanded.has(entry.path) ? rows(entry.path, depth + 1) : [])]);
  };

  const statusFor = (path: string, directory: boolean): GitFileStatus | null => {
    const relevant = statusEntries.filter((entry) => entry.path === path || (directory && entry.path.startsWith(`${path}/`)));
    if (relevant.some((entry) => entry.indexStatus === '?')) return 'untracked';
    if (relevant.some((entry) => entry.indexStatus !== '.')) return 'staged';
    if (relevant.some((entry) => entry.worktreeStatus !== '.')) return 'modified';
    return null;
  };

  return <div className="flex h-full min-h-0 min-w-0 border-t border-hairline">
    <aside className="flex w-72 shrink-0 flex-col border-r border-hairline bg-shell">
      <div className="border-b border-hairline px-4 py-3">
        <h1 className={`${displayTitle} text-ink`}>Files</h1>
        <div aria-label="Git status legend" className="mt-1.5 flex gap-2 text-[10px] text-muted">
          {(['staged', 'modified', 'untracked'] as const).map((status) => <span key={status} className="inline-flex items-center gap-1"><span aria-hidden="true" className={`size-1.5 rounded-full ${gitFileStatusClass(status).replace('text-', 'bg-')}`} />{status}</span>)}
        </div>
      </div>
      <nav aria-label="Workspace files" className="min-h-0 flex-1 overflow-auto py-2">
        {errors[''] && <p className="px-4 text-small text-fail">{errors['']}</p>}
        {rows().map(({ entry, depth }) => {
          const { path } = entry;
          const directory = entry.type === 'directory';
          const open = expanded.has(path);
          const status = statusFor(path, directory);
          return <button key={path} type="button" aria-expanded={directory ? open : undefined} aria-current={!directory && selectedPath === path ? 'page' : undefined} className={`flex min-h-8 w-full items-center gap-1.5 pr-3 text-left text-small ${selectedPath === path ? 'bg-accent-tint text-accent' : status ? `${gitFileStatusClass(status)} hover:bg-raised` : 'text-ink hover:bg-raised'}`} style={{ paddingLeft: `${0.75 + depth * 1}rem` }} onClick={() => {
            if (!directory) { onSelectFile(path); return; }
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
      </nav>
    </aside>
    <section className="flex min-w-0 flex-1 flex-col bg-sunken">
      {selectedPath && <header className="border-b border-hairline bg-shell px-4 py-3 font-code text-small text-muted">{selectedPath}</header>}
      {fileError ? <p className="p-4 text-small text-fail">{fileError}</p> : file?.isBinary ? <p className="p-4 text-small text-muted">This binary file cannot be displayed.</p> : file && selectedPath ? <CodeViewer path={selectedPath} text={file.text ?? ''} /> : <p className="p-4 text-small text-muted">Select a file to view it.</p>}
    </section>
  </div>;
}

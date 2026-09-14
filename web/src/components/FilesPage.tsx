import { useState } from 'react';
import { api } from '../api';
import type { WorkspaceFile, WorkspaceFileListing } from '../types';
import { useLiveEffect } from '../useLiveEffect';
import { Icon } from './Icon';
import { CodeViewer } from './CodeViewer';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function FilesPage({ workspaceId, selectedPath, onSelectFile }: { workspaceId: number; selectedPath: string | null; onSelectFile: (path: string) => void }) {
  const [listings, setListings] = useState<Record<string, WorkspaceFileListing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const load = (path: string, offset = 0) => api.workspaceFiles(workspaceId, path, offset).then((listing) => {
    setListings((current) => ({ ...current, [path]: offset === 0 ? listing : { ...listing, entries: [...(current[path]?.entries ?? []), ...listing.entries] } }));
    setErrors((current) => { const { [path]: _, ...rest } = current; return rest; });
  }, (error) => setErrors((current) => ({ ...current, [path]: errorText(error) })));

  useLiveEffect((live) => {
    setListings({}); setExpanded(new Set()); setErrors({});
    api.workspaceFiles(workspaceId).then((listing) => live() && setListings({ '': listing }), (error) => live() && setErrors({ '': errorText(error) }));
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

  return <div className="flex h-full min-h-0 min-w-0 border-t border-hairline">
    <aside className="flex w-72 shrink-0 flex-col border-r border-hairline bg-shell">
      <div className="border-b border-hairline px-4 py-3"><h1 className="font-semibold text-ink">Files</h1></div>
      <div role="tree" aria-label="Workspace files" className="min-h-0 flex-1 overflow-auto py-2">
        {errors[''] && <p className="px-4 text-small text-fail">{errors['']}</p>}
        {rows().map(({ entry, depth }) => {
          const { path } = entry;
          const directory = entry.type === 'directory';
          const open = expanded.has(path);
          return <button key={path} type="button" role="treeitem" aria-level={depth + 1} aria-expanded={directory ? open : undefined} aria-selected={selectedPath === path} className={`flex min-h-8 w-full items-center gap-1.5 pr-3 text-left text-small ${selectedPath === path ? 'bg-accent-tint text-accent' : 'text-ink hover:bg-raised'}`} style={{ paddingLeft: `${0.75 + depth * 1}rem` }} onClick={() => {
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
      {selectedPath && <header className="border-b border-hairline bg-shell px-4 py-3 font-code text-small text-muted">{selectedPath}</header>}
      {fileError ? <p className="p-4 text-small text-fail">{fileError}</p> : file?.isBinary ? <p className="p-4 text-small text-muted">This binary file cannot be displayed.</p> : file && selectedPath ? <CodeViewer path={selectedPath} text={file.text ?? ''} /> : <p className="p-4 text-small text-muted">Select a file to view it.</p>}
    </section>
  </div>;
}

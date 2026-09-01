import { railSectionCount, railSectionHead } from '../../ui';

export interface ChangedFileRow {
  path: string;
  additions: number;
  deletions: number;
  status?: 'M' | 'A' | 'D';
}

const BADGE: Record<'M' | 'A' | 'D', string> = {
  M: 'bg-running-tint text-running',
  A: 'bg-merged-tint text-merged',
  D: 'bg-fail-tint text-fail',
};

/** A changed file's badge letter: its own status when known, else newly added
 * reads as 'A' (the diffstat model only tags 'M'). */
export function changedFileKind(file: ChangedFileRow): 'M' | 'A' | 'D' {
  return file.status ?? (file.deletions === 0 && file.additions > 0 ? 'A' : 'M');
}

export function ChangedFilesNav({
  files,
  selectedFile,
  onSelectFile,
  onSelectChanges,
  emptyCopy,
  className = '',
}: {
  files: ChangedFileRow[];
  selectedFile?: string | null;
  onSelectFile: (path: string) => void;
  onSelectChanges: () => void;
  emptyCopy: string;
  className?: string;
}) {
  return (
    <>
      <button type="button" onClick={onSelectChanges} className={`${railSectionHead} ${className} hover:text-ink`}>
        Changed files{files.length > 0 && <span className={railSectionCount}>{files.length}</span>}
      </button>
      {files.length === 0 ? (
        <p className="text-small text-muted">{emptyCopy}</p>
      ) : (
        <div className="mt-0.5 flex flex-col">
          {files.map((file) => {
            const kind = changedFileKind(file);
            const sel = selectedFile === file.path;
            return (
              <button
                key={file.path}
                type="button"
                aria-pressed={sel}
                onClick={() => onSelectFile(file.path)}
                className={`flex items-center gap-2.5 rounded-sm px-[9px] py-2 text-left text-small transition-colors ${
                  sel ? 'bg-accent-tint' : 'hover:bg-raised'
                }`}
              >
                <span className={`grid size-[16px] shrink-0 place-items-center rounded-[4px] font-data text-[10px] font-bold ${BADGE[kind]}`}>
                  {kind}
                </span>
                <span className={`min-w-0 flex-1 truncate font-data text-[12px] ${sel ? 'text-accent' : 'text-ink'}`}>{file.path}</span>
                <span className="shrink-0 font-data text-[11px] tabular-nums">
                  {file.additions > 0 && <span className="text-merged">+{file.additions}</span>}
                  {file.deletions > 0 && <span className="ml-1 text-fail">−{file.deletions}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

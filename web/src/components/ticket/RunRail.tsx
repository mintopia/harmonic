import { changedFilesFromStat } from '../../run-rail-model';
import { railSectionCount, railSectionHead } from '../../ui';
import { Icon } from '../Icon';

const FADED: Record<'M' | 'A' | 'D', string> = {
  M: 'bg-running-tint text-running',
  A: 'bg-merged-tint text-merged',
  D: 'bg-fail-tint text-fail',
};

export function RunRail({
  worktree,
  selectedFile,
  onSelectFile,
  onSelectChanges,
}: {
  worktree: {
    branch: string | null;
    baseBranch: string | null;
    isolationMode: 'direct' | 'worktree';
    stat: string | null;
  };
  selectedFile?: string | null;
  onSelectFile: (path: string) => void;
  onSelectChanges: () => void;
}) {
  const files = changedFilesFromStat(worktree.stat);
  const hasWorktree = worktree.isolationMode === 'worktree' && Boolean(worktree.branch);

  return (
    <div aria-label="Worktree navigation">
      <section className="px-3.5 py-3.5">
        <div className={railSectionHead}>Worktree</div>
        {hasWorktree ? (
          <>
            <div className="flex min-w-0 items-center gap-2 font-data text-data text-ink">
              <Icon name="branch" className="size-3.5 shrink-0 text-muted opacity-80" />
              <span className="truncate">{worktree.branch}</span>
            </div>
            <div className="mt-[7px] flex flex-wrap gap-2 pl-[22px] text-[12px] text-faint">
              <span>
                base <span className="font-data text-muted">{worktree.baseBranch ?? 'HEAD'}</span>
              </span>
              <span className="text-edge">·</span>
              <span>
                isolation <span className="font-data text-muted">{worktree.isolationMode}</span>
              </span>
            </div>
          </>
        ) : (
          <p className="text-small text-muted">Direct mode — no worktree.</p>
        )}

        {hasWorktree && (
          <>
            <button
              type="button"
              onClick={onSelectChanges}
              className={`${railSectionHead} mt-4 hover:text-ink`}
            >
              Changed files{files.length > 0 && <span className={railSectionCount}>{files.length}</span>}
            </button>
            {files.length === 0 ? (
              <p className="text-small text-muted">No changed files yet.</p>
            ) : (
              <div className="mt-0.5 flex flex-col">
                {files.map((file) => {
                  // The stat model only tags 'M'; a file with additions and no
                  // deletions reads as newly added — surface it as 'A'.
                  const kind: 'M' | 'A' = file.deletions === 0 && file.additions > 0 ? 'A' : 'M';
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
                      <span
                        className={`grid size-[16px] shrink-0 place-items-center rounded-[4px] font-data text-[10px] font-bold ${FADED[kind]}`}
                      >
                        {kind}
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate font-data text-[12px] ${sel ? 'text-accent' : 'text-ink'}`}
                      >
                        {file.path}
                      </span>
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
        )}
      </section>
    </div>
  );
}

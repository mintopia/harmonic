import { changedFilesFromNumstat } from '../../attempt-rail-model';
import { railSectionHead } from '../../ui';
import { Icon } from '../Icon';
import type { TaskState } from '../../types';
import { ChangedFilesNav } from './ChangedFilesNav';

export function AttemptRail({
  worktree,
  selectedFile,
  onSelectFile,
  onSelectChanges,
  taskState,
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
  taskState?: TaskState;
}) {
  const files = changedFilesFromNumstat(worktree.stat);
  const hasWorktree = worktree.isolationMode === 'worktree';
  const merged = taskState === 'done';

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
          <ChangedFilesNav
            files={files}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            onSelectChanges={onSelectChanges}
            emptyCopy={merged ? 'No changed files.' : 'No changed files yet.'}
            className="mt-4"
          />
        )}
      </section>
    </div>
  );
}

import {
  changedFilesFromStat,
  continuationNote,
  runRailChips,
  type RunChip,
  type RunDot,
} from '../../run-rail-model';
import type { Run } from '../../types';
import { dot, runChip, runChipActive, runDotFill, sectionLabel } from '../../ui';
import { Icon } from '../Icon';

const WORD_TONE: Record<RunDot, string> = {
  running: 'text-running',
  fail: 'text-fail',
  merged: 'text-merged',
  review: 'text-await',
  neutral: 'text-muted',
};

function ChipDot({ chip }: { chip: RunChip }) {
  return (
    <span
      role="img"
      aria-label={chip.stateWord}
      className={`${dot} ${runDotFill[chip.dot]} ${chip.pulse ? 'motion-safe:animate-dot-pulse' : ''}`}
    />
  );
}

export function RunRail({
  runs,
  worktree,
  selectedRunId,
  selectedFile,
  onSelectRun,
  onSelectFile,
  onSelectChanges,
}: {
  runs: Run[];
  worktree: {
    branch: string | null;
    baseBranch: string | null;
    isolationMode: 'direct' | 'worktree';
    stat: string | null;
  };
  selectedRunId: number | null;
  selectedFile?: string | null;
  onSelectRun: (runId: number) => void;
  onSelectFile: (path: string) => void;
  onSelectChanges: () => void;
}) {
  const chips = runRailChips(runs);
  const note = continuationNote(runs);
  const files = changedFilesFromStat(worktree.stat);
  const hasWorktree = worktree.isolationMode === 'worktree' && Boolean(worktree.branch);
  const isRunSelected = (runId: number) => selectedFile === null && runId === selectedRunId;

  return (
    <aside aria-label="Run navigation" className="flex h-full min-h-0 flex-col gap-6">
      <section>
        <div className={`${sectionLabel} mb-2`}>
          Runs · {chips.length} attempt{chips.length === 1 ? '' : 's'}
        </div>
        {chips.length === 0 ? (
          <p className="text-small text-muted">This task hasn't run yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
          {chips.map((c) => (
            <button
              key={c.runId}
              type="button"
              aria-pressed={isRunSelected(c.runId)}
              onClick={() => onSelectRun(c.runId)}
              className={`w-full ${isRunSelected(c.runId) ? runChipActive : runChip}`}
            >
              <span className="flex items-center gap-2 text-data font-semibold text-ink">
                <ChipDot chip={c} />
                {c.label}
              </span>
              <span className="flex gap-2.5 pl-[15px] text-small text-faint">
                <span className={`font-semibold ${WORD_TONE[c.dot]}`}>{c.stateWord}</span>
                {c.cost && <span>{c.cost}</span>}
                {c.duration && <span>{c.duration}</span>}
              </span>
            </button>
          ))}
          </div>
        )}
        {note && (
          <div className="mt-2.5 flex items-center gap-1.5 text-small text-faint">
            <Icon name="refresh" className="size-3.5" />
            {note}
          </div>
        )}
      </section>

      <section>
        <div className={`${sectionLabel} mb-2`}>Worktree</div>
        {hasWorktree ? (
          <button
            type="button"
            onClick={onSelectChanges}
            className="min-h-11 w-full rounded-md border border-hairline bg-field px-3 py-2 text-left text-small transition-colors hover:border-edge"
          >
            <span className="block font-data text-data text-tool">{worktree.branch}</span>
            <span className="mt-1 block text-faint">
              {worktree.baseBranch ? <>from <span className="font-data text-data">{worktree.baseBranch}</span></> : 'worktree'}
            </span>
          </button>
        ) : (
          <p className="text-small text-muted">Direct mode — no worktree.</p>
        )}
      </section>

      <section className="min-h-0">
        <button
          type="button"
          onClick={onSelectChanges}
          className={`${sectionLabel} mb-2 flex min-h-11 items-center text-left hover:text-ink`}
        >
          Changed files{files.length > 0 ? ` · ${files.length}` : ''}
        </button>
        {!hasWorktree ? (
          <p className="text-small text-muted">Changes are available for worktree runs.</p>
        ) : files.length === 0 ? (
          <p className="text-small text-muted">No changed files yet.</p>
        ) : (
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                aria-pressed={selectedFile === file.path}
                onClick={() => onSelectFile(file.path)}
                className={`grid min-h-11 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left text-small transition-colors hover:bg-raised ${
                  selectedFile === file.path ? 'bg-await-tint text-ink' : 'text-muted'
                }`}
              >
                <span className="rounded bg-raised px-1 font-data text-label font-semibold text-faint">{file.kind}</span>
                <span className="truncate font-data text-data">{file.path}</span>
                <span className="text-label tabular-nums text-faint">
                  +{file.additions} −{file.deletions}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}

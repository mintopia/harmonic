import {
  changedFilesFromStat,
  continuationNote,
  runRailChips,
  type RunChip,
  type RunDot,
} from '../../run-rail-model';
import type { Run } from '../../types';
import { runDotFill } from '../../ui';
import { Icon } from '../Icon';

const WORD_TONE: Record<RunDot, string> = {
  running: 'text-running',
  fail: 'text-fail',
  merged: 'text-merged',
  review: 'text-await',
  neutral: 'text-muted',
};

const ssechd = 'mb-2.5 flex items-center gap-2 text-label font-bold uppercase tracking-[0.1em] text-faint';
const ssecCount = 'rounded-full bg-raised px-[7px] text-[11px] font-bold normal-case tracking-normal text-muted';

function ChipDot({ chip }: { chip: RunChip }) {
  return (
    <span
      role="img"
      aria-label={chip.stateWord}
      className={`size-2 shrink-0 rounded-full ${runDotFill[chip.dot]} ${chip.pulse ? 'motion-safe:animate-dot-pulse' : ''}`}
    />
  );
}

const FADED: Record<'M' | 'A' | 'D', string> = {
  M: 'bg-running-tint text-running',
  A: 'bg-merged-tint text-merged',
  D: 'bg-fail-tint text-fail',
};

// Run switching drives the whole pane, so it must stay reachable. Vertical in
// the wide rail; a sticky horizontal strip at narrow widths where the rail
// stacks below the fold (layout="strip").
export function RunAttempts({
  runs,
  selectedRunId,
  selectedFile,
  onSelectRun,
  layout = 'rail',
}: {
  runs: Run[];
  selectedRunId: number | null;
  selectedFile?: string | null;
  onSelectRun: (runId: number) => void;
  layout?: 'rail' | 'strip';
}) {
  const chips = runRailChips(runs);
  const note = continuationNote(runs);
  const isRunSelected = (runId: number) => selectedFile === null && runId === selectedRunId;
  const strip = layout === 'strip';
  return (
    <section className={strip ? '' : 'border-b border-hairline px-3.5 py-3.5'}>
      <div className={ssechd}>
        Run attempts <span className={ssecCount}>{chips.length}</span>
      </div>
      {chips.length === 0 ? (
        <p className="text-small text-muted">This task hasn't run yet.</p>
      ) : (
        <div className={strip ? 'flex gap-1.5 overflow-x-auto pb-0.5' : 'flex flex-col gap-1'}>
          {chips.map((c) => (
            <button
              key={c.runId}
              type="button"
              aria-pressed={isRunSelected(c.runId)}
              onClick={() => onSelectRun(c.runId)}
              className={`flex min-h-11 items-center gap-2.5 rounded-sm border px-2.5 py-2 text-left transition-colors ${
                strip ? 'shrink-0' : 'w-full'
              } ${
                isRunSelected(c.runId)
                  ? 'border-await bg-await-tint'
                  : 'border-transparent hover:bg-raised'
              }`}
            >
              <ChipDot chip={c} />
              <span className="text-data font-semibold text-ink">{c.label}</span>
              <span className="ml-auto text-right text-[11.5px] leading-[1.35] tabular-nums text-faint">
                <span className={`text-label font-bold uppercase tracking-[0.03em] ${WORD_TONE[c.dot]}`}>
                  {c.stateWord}
                </span>
                {strip ? ' ' : <br />}
                {[c.cost, c.duration].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
        </div>
      )}
      {note && !strip && (
        <div className="mt-2.5 flex items-center gap-1.5 text-small text-faint">
          <Icon name="refresh" className="size-3.5" />
          {note}
        </div>
      )}
    </section>
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
  const files = changedFilesFromStat(worktree.stat);
  const hasWorktree = worktree.isolationMode === 'worktree' && Boolean(worktree.branch);

  return (
    <div aria-label="Run navigation">
      {/* At narrow widths a sticky strip in the main pane owns run-switching. */}
      <div className="max-rail:hidden">
        <RunAttempts
          runs={runs}
          selectedRunId={selectedRunId}
          selectedFile={selectedFile}
          onSelectRun={onSelectRun}
        />
      </div>

      <section className="px-3.5 py-3.5">
        <div className={ssechd}>Worktree</div>
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
              className={`${ssechd} mt-4 hover:text-ink`}
            >
              Changed files{files.length > 0 && <span className={ssecCount}>{files.length}</span>}
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

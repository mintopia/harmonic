import { continuationNote, runRailChips, type RunChip, type RunDot } from '../../run-rail-model';
import type { Run } from '../../types';
import { dot, runChip, runChipActive, runDotFill, sectionLabel } from '../../ui';
import { Icon } from '../Icon';

/** The rc-state word's ink (prototype `.rc-state.*`): both `failed` and
 * `rejected` fold to the `fail` RunDot in the locked `runDisplay` model, so
 * both read Failed rose here — the model doesn't keep them apart, and this
 * component doesn't re-derive a distinction it doesn't have. */
const WORD_TONE: Record<RunDot, string> = {
  running: 'text-running',
  fail: 'text-fail',
  merged: 'text-merged',
  review: 'text-await',
  neutral: 'text-muted',
};

function ChipDot({ chip }: { chip: RunChip }) {
  return (
    <span aria-hidden className={`${dot} ${runDotFill[chip.dot]} ${chip.pulse ? 'motion-safe:animate-dot-pulse' : ''}`} />
  );
}

/**
 * The Ticket page's run rail (issue #183, part of #179): one chip per Run,
 * switching which Run's detail renders below. Pure presentation over the
 * locked `run-rail-model` — this component derives nothing about a Run's
 * disposition itself, it only maps `RunChip`/the continuation note to markup
 * (prototype lines 484–502).
 */
export function RunRail({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: Run[];
  selectedRunId: number | null;
  onSelect: (runId: number) => void;
}) {
  const chips = runRailChips(runs);
  const note = continuationNote(runs);

  return (
    <div className="mb-0.5 mt-[22px]">
      <div className={`${sectionLabel} mb-2`}>
        Runs · {chips.length} attempt{chips.length === 1 ? '' : 's'}
      </div>
      {chips.length === 0 ? (
        <p className="text-muted">This task hasn't run yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2.5">
          {chips.map((c) => (
            <button
              key={c.runId}
              type="button"
              aria-pressed={c.runId === selectedRunId}
              onClick={() => onSelect(c.runId)}
              className={c.runId === selectedRunId ? runChipActive : runChip}
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
        <div className="mt-2.5 inline-flex items-center gap-1.5 text-small text-faint">
          <Icon name="refresh" className="size-3.5" />
          {note}
        </div>
      )}
    </div>
  );
}

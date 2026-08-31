import { card, labelType } from '../ui';
import {
  criticVerdictSlices,
  criticVerdictTotal,
  gateOutcomeBars,
  guardrailTripBars,
  settledTaskTotal,
  verificationCardEmpty,
  type GateOutcomes,
  type VerdictCounts,
} from '../stats-model';
import { guardrailDimensionLabel } from '../guardrail-trip-model';
import { Donut, type DonutSegment } from './Donut';

// The three panels ARE status here (a verdict, a gate exit, a guardrail), so
// they take the status tones directly — unlike the token-class bars, whose
// colours are a categorical key, not a state.
const VERDICT_COLOR: Record<string, string> = {
  pass: 'var(--hm-merged-dot)',
  block: 'var(--hm-fail-dot)',
  inconclusive: 'var(--hm-running-dot)',
};
const VERDICT_LABEL: Record<string, string> = {
  pass: 'Pass',
  block: 'Block',
  inconclusive: 'Inconclusive',
};
const GATE_COLOR: Record<string, string> = {
  autoMerged: 'var(--hm-merged-dot)',
  escalated: 'var(--hm-await-dot)',
  revertedOnRed: 'var(--hm-fail-dot)',
};
const GATE_LABEL: Record<string, string> = {
  autoMerged: 'Auto-merged',
  escalated: 'Escalated',
  revertedOnRed: 'Reverted on red',
};

const fmt = (n: number) => n.toLocaleString();

function PanelLabel({ children }: { children: string }) {
  return <div className={`${labelType} mb-3 text-muted`}>{children}</div>;
}

/** One labelled bar: label, a filled track, and the count. `share` is the fill
 * fraction (0..1) — the gate normalises to the settled total so its bars
 * reconcile, guardrails normalise to the widest so the ranking reads. */
function BarRow({ label, count, share, color }: { label: string; count: number; share: number; color: string }) {
  return (
    <div className="grid grid-cols-[minmax(6rem,9rem)_1fr_auto] items-center gap-3">
      <span className="truncate text-data text-ink" title={label}>
        {label}
      </span>
      <span className="h-2 overflow-hidden rounded-full bg-raised" aria-hidden="true">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.max(count > 0 ? 3 : 0, share * 100)}%`, backgroundColor: color }}
        />
      </span>
      <span className="whitespace-nowrap text-right text-data tabular-nums text-muted">{fmt(count)}</span>
    </div>
  );
}

export function VerificationEscalationCard({
  verdicts,
  gateOutcomes,
  guardrailTrips,
}: {
  verdicts: { critic: VerdictCounts };
  gateOutcomes: GateOutcomes;
  guardrailTrips: Record<string, number>;
}) {
  const critic = verdicts.critic;
  const criticTotal = criticVerdictTotal(critic);
  const verdictSegments: DonutSegment[] = criticVerdictSlices(critic).map(({ key, count }) => ({
    key,
    label: VERDICT_LABEL[key],
    value: count,
    color: VERDICT_COLOR[key]!,
  }));

  const settled = settledTaskTotal(gateOutcomes);
  const gateBars = gateOutcomeBars(gateOutcomes);

  const guardrailBars = guardrailTripBars(guardrailTrips);
  const guardrailMax = Math.max(...guardrailBars.map((b) => b.count), 1);

  return (
    <section className={`${card} mt-4 p-5`}>
      <h2 className="mb-4 text-title font-semibold">Verification &amp; escalation</h2>

      {verificationCardEmpty(critic, gateOutcomes, guardrailTrips) ? (
        <p className="text-muted">No verifications, merge-gate outcomes, or guardrail trips in range.</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <PanelLabel>Critic verdicts</PanelLabel>
            {criticTotal === 0 ? (
              <p className="text-muted">No critic verdicts in range.</p>
            ) : (
              <Donut
                segments={verdictSegments}
                total={criticTotal}
                totalLabel={criticTotal === 1 ? 'VERDICT' : 'VERDICTS'}
                ariaLabel="Critic verdicts by outcome"
              />
            )}
          </div>

          <div className="flex flex-col gap-6">
            <div>
              <PanelLabel>Merge gate</PanelLabel>
              {settled === 0 ? (
                <p className="text-muted">No Tasks settled in range.</p>
              ) : (
                <>
                  <div className="flex flex-col gap-2.5" role="table" aria-label="Merge-gate outcomes">
                    {gateBars.map(({ key, count }) => (
                      <BarRow
                        key={key}
                        label={GATE_LABEL[key]!}
                        count={count}
                        share={count / settled}
                        color={GATE_COLOR[key]!}
                      />
                    ))}
                  </div>
                  <p className="mt-2.5 text-label text-faint">
                    = {fmt(settled)} settled {settled === 1 ? 'task' : 'tasks'}
                  </p>
                </>
              )}
            </div>

            <div>
              <PanelLabel>Guardrail trips</PanelLabel>
              {guardrailBars.length === 0 ? (
                <p className="text-muted">No guardrail trips in range.</p>
              ) : (
                <div className="flex flex-col gap-2.5" role="table" aria-label="Guardrail trips by dimension">
                  {guardrailBars.map(({ key, count }) => (
                    <BarRow
                      key={key}
                      label={guardrailDimensionLabel(key)}
                      count={count}
                      share={count / guardrailMax}
                      color="var(--hm-running-dot)"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

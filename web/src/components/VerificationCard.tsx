import { latestAttempts, overallDecision, latestCriticSummary } from '../verification-attempts-model';
import type { VerificationOutcome, Verdict } from '../verification-model';
import type { VerificationAttempt } from '../types';
import { chip, labelType } from '../ui';

/**
 * Verdict/outcome → tint+text tone (issue #169, part of #109). There is no
 * dedicated "pass/ok" semantic token in `index.css` — `--hm-accept` ("completed
 * / accepted") is the closest existing positive-outcome token, already reused
 * elsewhere for a favourable state (`STATE_CHIP_STYLES.completed` in ui.ts), so
 * a `pass` verdict / `proceed` outcome takes it here rather than inventing a
 * new token. `fail`/`block` take the existing fail tokens directly. For
 * `inconclusive`/`escalate` this reuses running-amber, following the precedent
 * `ui.ts`'s `escalatedChip` sets in its own comment ("afk→hitl escalation
 * reuses Running amber's tint/ink because 'work in flight, now yours' is the
 * closest existing meaning") — an escalated Verification is the same shape of
 * event, handed to a human.
 */
const VERDICT_TONE: Record<Verdict, string> = {
  pass: 'bg-accept-tint text-accept',
  fail: 'bg-fail-tint text-fail',
  inconclusive: 'bg-running-tint text-running',
};

const OUTCOME_TONE: Record<VerificationOutcome, string> = {
  proceed: 'bg-accept-tint text-accept',
  block: 'bg-fail-tint text-fail',
  escalate: 'bg-running-tint text-running',
};

function verdictChip(verdict: Verdict): string {
  return `${chip} ${VERDICT_TONE[verdict]}`;
}

function outcomeChip(outcome: VerificationOutcome): string {
  return `${chip} ${OUTCOME_TONE[outcome]}`;
}

/**
 * A Run's Verification readout (issue #169, part of #109): the overall
 * proceed/block/escalate outcome, the current per-verifier verdicts (latest
 * attempt per mechanism), the latest critic summary, and the full attempts
 * log in seq order. Follows `GuardrailTrips`'s presentational shape
 * (TaskDetail.tsx) — one prop, no internal fetch/state, empty guard returns
 * null — but renders in the Details tab rather than the always-visible header,
 * since a full attempts log is heavier than a one-line trip banner. All
 * derivation is delegated to `verification-attempts-model.ts` + `combineVerdicts`
 * — this component only maps and renders.
 */
export function VerificationCard({ attempts }: { attempts: VerificationAttempt[] }) {
  if (attempts.length === 0) return null;

  const decision = overallDecision(attempts);
  const current = latestAttempts(attempts);
  const criticSummary = latestCriticSummary(attempts);
  const bySeq = [...attempts].sort((a, b) => a.seq - b.seq);

  return (
    <div className="py-3 first:pt-0">
      <div className={`${labelType} mb-1 text-muted`}>Verification</div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={outcomeChip(decision.outcome)}>{decision.outcome}</span>
        <span className="text-small text-muted">{decision.reason}</span>
      </div>

      {current.length > 0 && (
        <dl className="mt-2 grid grid-cols-[max-content_max-content_1fr] items-baseline gap-x-3 gap-y-1 text-small">
          {current.map((attempt) => (
            <div key={attempt.mechanism} className="contents">
              <dt className="font-medium text-ink">{attempt.mechanism}</dt>
              <dd>
                <span className={verdictChip(attempt.verdict)}>{attempt.verdict}</span>
              </dd>
              <dd className="min-w-0 text-muted">{attempt.summary}</dd>
            </div>
          ))}
        </dl>
      )}

      {criticSummary && (
        <div className="mt-2 rounded-md bg-raised px-3 py-2 text-small">
          <span className={`${labelType} text-muted`}>Critic summary</span>
          <p className="mt-0.5 whitespace-pre-wrap text-ink">{criticSummary}</p>
        </div>
      )}

      <div className="mt-2 space-y-1">
        <div className={`${labelType} text-muted`}>Attempts</div>
        {bySeq.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-2 text-small">
            <span className="font-medium text-ink">{a.mechanism}</span>
            <span className={verdictChip(a.verdict)}>{a.verdict}</span>
            <span className="text-muted">{a.phase}</span>
            {a.mutated && <span className={`${chip} bg-raised text-muted`}>mutated</span>}
            <span className="min-w-0 text-muted">{a.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

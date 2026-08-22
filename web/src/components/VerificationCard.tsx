import { latestAttempts, overallDecision, latestCriticSummary, groupAttemptsByMechanism } from '../verification-attempts-model';
import type { VerificationOutcome, Verdict } from '../verification-model';
import type { VerificationAttempt } from '../types';
import { chip, labelType } from '../ui';
import { Icon } from './Icon';
import type { IconName } from './Icon';

const VERDICT_TONE: Record<Verdict, string> = {
  pass: 'bg-merged-tint text-merged',
  fail: 'bg-fail-tint text-fail',
  inconclusive: 'bg-running-tint text-running',
};

const OUTCOME_TONE: Record<VerificationOutcome, string> = {
  proceed: 'bg-merged-tint text-merged',
  block: 'bg-fail-tint text-fail',
  escalate: 'bg-running-tint text-running',
};

/**
 * Verdict/outcome → glyph (issue #174): the tone above is colour alone, which
 * fails for colourblind operators, so every chip also carries a shape —
 * `check` for the good outcome, `close` for the bad one, and the new
 * `alert-triangle` for "needs a human" (inconclusive/escalate), mirroring the
 * tone's own pass/fail/inconclusive grouping one-for-one.
 */
const VERDICT_ICON: Record<Verdict, IconName> = {
  pass: 'check',
  fail: 'close',
  inconclusive: 'alert-triangle',
};

const OUTCOME_ICON: Record<VerificationOutcome, IconName> = {
  proceed: 'check',
  block: 'close',
  escalate: 'alert-triangle',
};

// `inline-flex items-center gap-1` lets the glyph sit before the label inside
// the chip (icon+colour+text, never colour alone) without touching `chip`
// itself, which other callers rely on staying a plain inline pill.
function verdictChip(verdict: Verdict): string {
  return `${chip} ${VERDICT_TONE[verdict]} inline-flex items-center gap-1`;
}

function outcomeChip(outcome: VerificationOutcome): string {
  return `${chip} ${OUTCOME_TONE[outcome]} inline-flex items-center gap-1`;
}

export function VerificationCard({ attempts }: { attempts: VerificationAttempt[] }) {
  if (attempts.length === 0) {
    return (
      <div className="py-3 first:pt-0">
        <div className={`${labelType} mb-1 text-muted`}>Verification</div>
        <div className="flex items-center gap-2 text-small text-muted">
          <span className={`${chip} bg-raised text-muted`}>pending</span>
          <span>No verification results yet</span>
        </div>
      </div>
    );
  }

  const decision = overallDecision(attempts);
  const current = latestAttempts(attempts);
  const criticSummary = latestCriticSummary(attempts);
  const groups = groupAttemptsByMechanism(attempts);

  return (
    <div className="py-3 first:pt-0">
      <div className={`${labelType} mb-1 text-muted`}>Verification</div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={outcomeChip(decision.outcome)}>
          <Icon className="size-3" name={OUTCOME_ICON[decision.outcome]} />
          {decision.outcome}
        </span>
        <span className="text-small text-muted">{decision.reason}</span>
      </div>

      {current.length > 0 && (
        <dl className="mt-2 grid grid-cols-[max-content_max-content_1fr] items-baseline gap-x-3 gap-y-1 text-small">
          {current.map((attempt) => (
            <div key={attempt.mechanism} className="contents">
              <dt className="font-medium text-ink">{attempt.mechanism}</dt>
              <dd>
                <span className={verdictChip(attempt.verdict)}>
                  <Icon className="size-3" name={VERDICT_ICON[attempt.verdict]} />
                  {attempt.verdict}
                </span>
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

      <div className="mt-2 space-y-2">
        <div className={`${labelType} text-muted`}>Attempts</div>
        {groups.map((group) => (
          <div key={group.mechanism} className="space-y-1">
            <div className="text-small font-medium text-ink">{group.mechanism}</div>
            {group.attempts.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-2 pl-3 text-small">
                <span className="text-muted">
                  attempt {a.attemptNumber} of {group.attempts.length}
                </span>
                {a.isSelfHeal && <span className={`${chip} bg-raised text-muted`}>self-heal</span>}
                <span className={verdictChip(a.verdict)}>
                  <Icon className="size-3" name={VERDICT_ICON[a.verdict]} />
                  {a.verdict}
                </span>
                <span className="text-muted">{a.phase}</span>
                {a.mutated && <span className={`${chip} bg-raised text-muted`}>mutated</span>}
                <span className="min-w-0 text-muted">{a.summary}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

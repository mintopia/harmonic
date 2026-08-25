import { useState } from 'react';
import { api } from '../../api.js';
import { elapsed, feedbackForAttempt, stateTone, taskLabel } from '../../attempt-timeline-model.js';
import type { Attempt, AttemptTask } from '../../types.js';
import { Icon } from '../Icon.js';

const TONE = {
  running: 'bg-running-tint text-running',
  passed: 'bg-merged-tint text-merged',
  failed: 'bg-fail-tint text-fail',
  neutral: 'bg-raised text-muted',
} as const;

function TaskRow({ task, now }: { task: AttemptTask; now: number }) {
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const tone = stateTone(task.state);
  const logAvailable = task.logLocator !== null;
  return (
    <li className="border-t border-hairline first:border-t-0">
      <div className="flex min-h-11 items-center gap-3 py-2 text-small">
        <span className={`grid size-[18px] shrink-0 place-items-center rounded-full ${TONE[tone]}`} role="img" aria-label={task.state}>
          {task.state === 'passed' ? <Icon name="check" className="size-3" /> : <span className="text-[10px] font-bold">{task.state === 'failed' ? '×' : '•'}</span>}
        </span>
        <span className="min-w-0 flex-1 font-medium text-ink">{taskLabel(task)}</span>
        <span className="shrink-0 tabular-nums text-faint">{elapsed(task.startedAt, task.endedAt, now)}</span>
        <span className={`shrink-0 text-label font-bold uppercase tracking-[0.06em] ${TONE[tone].split(' ')[1]}`}>
          {task.verdict ?? task.state}
        </span>
        {logAvailable && (
          <button type="button" onClick={() => {
            const next = !open;
            setOpen(next);
            const match = /^verification_attempt:(\\d+)$/.exec(task.logLocator ?? '');
            if (next && match && output === null) api.verificationAttempt(Number(match[1])).then(({ output: nextOutput }) => setOutput(nextOutput), () => setOutput('Log unavailable.'));
          }} aria-expanded={open} className="min-h-11 px-1 text-muted hover:text-ink">
            <span className="sr-only">{open ? 'Hide' : 'Show'} log for {taskLabel(task)}</span>
            <Icon name="chevron-down" className={`size-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
          </button>
        )}
      </div>
      {open && (
        <div className="mb-3 ml-[30px] rounded-sm bg-sunken px-3 py-2 font-data text-[12px] leading-relaxed text-muted">
          {output ?? (task.logLocator?.startsWith('session:') ? 'Implementation events are available from the active ACP session.' : 'Loading log…')}
        </div>
      )}
    </li>
  );
}

export function AttemptTimeline({ attempts, now }: { attempts: Attempt[]; now: number }) {
  if (attempts.length === 0) return <p className="py-8 text-muted">No attempts yet.</p>;
  return (
    <section className="py-5" aria-label="Attempt history">
      <h2 className="mb-3 text-title font-bold text-ink">Attempt history</h2>
      <div className="space-y-5">
        {attempts.map((attempt) => {
          const feedback = feedbackForAttempt(attempts, attempt);
          return (
            <article key={attempt.id} className="border border-hairline bg-surface px-4 py-3">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="font-semibold text-ink">Attempt {attempt.number}</h3>
                <span className="text-small text-muted">{attempt.state}</span>
                <span className="ml-auto text-small tabular-nums text-faint">{elapsed(attempt.startedAt, attempt.endedAt, now)}</span>
              </div>
              <p className="mb-2 text-small text-faint">{attempt.number > 1 ? 'new session, condensed' : 'new session'}</p>
              <ol><>{attempt.tasks.map((task) => <TaskRow key={task.id} task={task} now={now} />)}</></ol>
              {feedback && <div className="mt-3 border-t border-hairline pt-3 text-small text-muted"><span className="font-semibold text-ink">Feedback for the next attempt</span><div className="mt-1 whitespace-pre-wrap">{feedback}</div></div>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

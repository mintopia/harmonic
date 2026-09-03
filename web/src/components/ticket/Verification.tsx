import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { harnessLabel } from '../../task-detail-model';
import { criticUnavailableReason, overallDecision, verificationRows } from '../../verification-attempts-model';
import type { AttemptLogEvent, AttemptSummary, Step, VerificationAttempt, VerifierStatus } from '../../types';
import { useLiveEffect } from '../../useLiveEffect';
import { useCriticLiveStream } from '../useCriticLiveStream';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { ChatTranscript } from './ChatTranscript';

const sectionCaps = 'text-label font-bold uppercase tracking-[0.1em] text-faint';

const OUTCOME_TONE: Record<string, string> = {
  proceed: 'text-merged',
  block: 'text-fail',
  escalate: 'text-running',
};
const VERDICT_TONE: Record<string, string> = {
  pass: 'text-merged',
  fail: 'text-fail',
  inconclusive: 'text-running',
};

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function criticModel(run: AttemptSummary): string | null {
  const key = Object.keys(run.usage?.models ?? {}).find((k) => /critic/i.test(k));
  return key?.split('·')[1]?.trim() ?? null;
}

function mechanismName(mechanism: string, run: AttemptSummary): string {
  if (mechanism === 'critic') {
    const model = criticModel(run);
    return model ? `Critic · ${model}` : 'Critic';
  }
  return mechanism.charAt(0).toUpperCase() + mechanism.slice(1);
}

function CriticSession({ attemptId, label, model, agent }: { attemptId: number; label: string; model: string; agent: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [events, setEvents] = useState<AttemptLogEvent[]>([]);

  useLiveEffect((live) => {
    setState('loading');
    api.criticLog(attemptId).then(
      (log) => {
        if (!live()) return;
        if (log.status === 'available' && log.events.length > 0) {
          setEvents(log.events);
          setState('ready');
        } else {
          setState('unavailable');
        }
      },
      () => live() && setState('unavailable'),
    );
  }, [attemptId]);

  if (state === 'loading') return <p className="mt-3 text-[12px] text-muted">Loading critic session…</p>;
  if (state === 'unavailable') return <p className="mt-3 text-[12px] text-muted">Critic session log could not be loaded.</p>;
  return <ChatTranscript events={events} unavailable={false} model={model} agent={agent} stepLabel={label} />;
}

export function CriticSessions({ attempts, run }: { attempts: VerificationAttempt[]; run: AttemptSummary }) {
  const sessions = attempts.filter((a) => a.mechanism === 'critic' && a.hasTranscript);
  if (sessions.length === 0) return null;
  const model = criticModel(run) ?? 'critic';
  return (
    <div className="flex flex-col gap-2">
      {sessions.map((c, i) => (
        <CriticSession key={c.id} attemptId={c.id} model={model} agent={c.harness ? harnessLabel(c.harness) : 'Critic'} label={sessions.length > 1 ? `Critic ${i + 1} of ${sessions.length} · ${c.verdict}` : 'Critic'} />
      ))}
    </div>
  );
}

/** The critic while it runs: its own live ACP transcript streamed on the critic
 * channel, rendered through the same chat viewer as the builder and the settled
 * critic session — the running and finished views are the same component. */
function CriticLive({ attemptId, model, agent }: { attemptId: number; model: string; agent: string }) {
  const events = useCriticLiveStream(attemptId);
  return <ChatTranscript events={events} unavailable={false} model={model} agent={agent} stepLabel="Critic" />;
}

function RunningVerifier({ step, output }: { step: Step | undefined; output: string | null }) {
  const tailRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = tailRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);
  // eslint-disable-next-line react/purity -- one-shot elapsed read; the parent re-renders on every live update
  const elapsed = step?.startedAt ? Date.now() - step.startedAt : null;
  return (
    <div className="mt-2">
      <p className="text-[12px] text-running">{elapsed !== null && elapsed > 0 ? `Running for ${fmtDur(elapsed)}` : 'Starting…'}</p>
      {output ? <pre ref={tailRef} className="mt-2 max-h-72 overflow-auto rounded-md border border-hairline bg-sunken px-3 py-2 font-data text-[11.5px] leading-[1.55] text-muted">{output}</pre> : <p className="mt-1 text-[12px] text-faint">Waiting for output…</p>}
    </div>
  );
}

export interface VerificationProps {
  attempts: VerificationAttempt[];
  statuses: VerifierStatus[];
  run: AttemptSummary;
  only?: 'command' | 'critic';
  steps?: readonly Step[];
  liveOutput?: string | null;
  /** Author label for the running critic's live transcript (the reviewing
   * harness); the settled session derives its own from the persisted row. */
  criticAgent?: string;
}

export function Verification({ attempts, statuses, run, only, steps = [], liveOutput = null, criticAgent }: VerificationProps) {
  const decision = overallDecision(attempts);
  const rows = verificationRows(statuses, attempts).filter(({ status }) => !only || status.mechanism === only);
  const criticSessions = attempts.filter((a) => a.mechanism === 'critic' && a.hasTranscript);
  const hasPlanned = statuses.some((status) => status.state === 'planned');
  const commandRow = rows.find(({ status }) => status.mechanism === 'command');
  const commandCount = commandRow?.status.commands?.length ?? 0;
  const reviewRow = rows.find(({ status }) => status.mechanism === 'critic');
  const reviewInPlan = reviewRow ? reviewRow.status.state !== 'disabled' : false;
  const gateCaption = reviewInPlan && commandCount >= 1 ? 'Runs top to bottom — review gates on all commands passing.' : commandCount + (reviewInPlan ? 1 : 0) >= 2 ? 'Runs top to bottom.' : null;
  return (
    <div className="mt-2">
      {!only && <div className="flex items-center"><span className={sectionCaps}>Verification</span><span className={`ml-auto inline-flex items-center gap-1.5 text-[12.5px] font-semibold ${attempts.length > 0 ? OUTCOME_TONE[decision.outcome] ?? 'text-muted' : 'text-muted'}`}><span className="size-2 rounded-full bg-current" />{attempts.length > 0 ? decision.outcome : hasPlanned ? 'planned' : 'not run'}</span></div>}
      {!only && gateCaption && <p className="mt-1 text-[12px] text-muted">{gateCaption}</p>}
      <div className="mt-3 flex flex-col gap-3">
        {rows.map(({ status, attempt }) => {
          const criticReason = status.mechanism === 'critic' && criticSessions.length === 0 ? criticUnavailableReason(status.state, !!attempt, false) : null;
          return <div key={status.mechanism} className="flex items-start gap-3">
            <span className={`mt-px grid size-[18px] shrink-0 place-items-center rounded-md ${status.state === 'failed' || status.state === 'unrunnable' ? 'bg-fail-tint text-fail' : status.state === 'passed' ? 'bg-merged-tint text-merged' : status.state === 'running' ? 'bg-running-tint text-running' : 'bg-raised text-muted'}`}>
              {status.state === 'running' ? <span className="size-2 animate-pulse rounded-full bg-current motion-reduce:animate-none" /> : status.state === 'failed' ? <span className="text-[11px] leading-none">✕</span> : status.state === 'unrunnable' ? <span className="text-[11px] leading-none font-bold">!</span> : status.state === 'passed' ? <Icon name="check" className="size-3" /> : status.state === 'planned' ? <span className="size-2 rounded-full border border-current" /> : <span className="text-[11px] leading-none">–</span>}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-[13px] font-semibold ${status.state === 'disabled' ? 'text-muted' : 'text-ink'}`}>{mechanismName(status.mechanism, run)}</div>
              <div className="mt-1 text-[13px] leading-[1.55] text-muted [&_code]:rounded-[5px] [&_code]:bg-raised [&_code]:px-[5px] [&_code]:py-px [&_code]:font-data [&_code]:text-[12px]">{attempt ? attempt.mechanism === 'critic' ? <Markdown source={attempt.summary} className="text-muted" /> : attempt.summary : status.reason}</div>
              {status.commands && status.commands.length > 0 && <ol className="mt-1 flex flex-col gap-0.5">{status.commands.map((cmd, i) => <li key={i} className="text-[12px] text-muted"><span className="mr-1.5 tabular-nums text-edge">{i + 1}.</span><code className="rounded-[5px] bg-raised px-[5px] py-px font-data text-[12px]">{cmd}</code></li>)}</ol>}
              {criticReason && <p className="mt-2 text-[12px] text-muted">{criticReason}</p>}
              {status.state === 'running' && (status.mechanism === 'critic'
                ? <CriticLive attemptId={run.id} model={criticModel(run) ?? 'critic'} agent={criticAgent ?? 'Critic'} />
                : <RunningVerifier step={steps.find((s) => s.type === 'verification' && s.state === 'running')} output={liveOutput} />)}
            </div>
            <span className={`shrink-0 text-[10px] font-bold uppercase tracking-[0.04em] ${attempt ? VERDICT_TONE[attempt.verdict] ?? 'text-muted' : status.state === 'running' ? 'text-running' : 'text-muted'}`}>{status.state}</span>
          </div>;
        })}
      </div>
    </div>
  );
}

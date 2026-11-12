import { useState } from 'react';
import { api } from '../../api';
import { errorText } from '../../error-text';
import { harnessLabel } from '../../task-detail-model';
import type { AttemptLogEvent, AttemptSummary, VerificationAttempt } from '../../types';
import { useLiveEffect } from '../../useLiveEffect';
import { ChatTranscript } from './ChatTranscript';
import { PromptSent, PromptSentCard } from './Description';

function criticModel(run: AttemptSummary): string | null {
  const key = Object.keys(run.usage?.models ?? {}).find((k) => /critic/i.test(k));
  return key?.split('·')[1]?.trim() ?? null;
}

function CriticSession({ attemptId, label, model, agent, baseDir }: { attemptId: number; label: string; model: string; agent: string; baseDir?: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'unavailable' | 'error'>('loading');
  const [events, setEvents] = useState<AttemptLogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fromArchive, setFromArchive] = useState(false);

  useLiveEffect((live) => {
    setState('loading');
    setError(null);
    api.criticLog(attemptId).then(
      (log) => {
        if (!live()) return;
        if (log.status === 'available' && log.events.length > 0) {
          setEvents(log.events);
          setFromArchive(log.fromArchive === true);
          setState('ready');
        } else if (log.status === 'available') {
          setState('empty');
        } else {
          setState('unavailable');
        }
      },
      (e) => {
        if (!live()) return;
        setError(errorText(e));
        setState('error');
      },
    );
  }, [attemptId]);

  if (state === 'loading') return <p className="mt-3 text-[12px] text-muted">Loading critic session…</p>;
  if (state === 'empty') return <p className="mt-3 text-[12px] text-muted">No critic session events recorded.</p>;
  if (state === 'unavailable') return <p className="mt-3 text-[12px] text-muted">Critic session log could not be loaded.</p>;
  if (state === 'error') return <p role="alert" className="mt-3 text-[12px] text-fail">Failed to load critic session{error ? `: ${error}` : '.'}</p>;
  return <ChatTranscript events={events} unavailable={false} model={model} agent={agent} stepLabel={label} fromArchive={fromArchive} baseDir={baseDir} />;
}

function ResolvedPrompt({ attemptId, locator }: { attemptId: number; locator: string }) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useLiveEffect((live) => {
    setPrompt(null);
    setFailed(false);
    api.resolvedPrompt({ attemptId }, locator).then(
      (text) => {
        if (live()) setPrompt(text);
      },
      () => {
        if (live()) setFailed(true);
      },
    );
  }, [attemptId, locator]);

  if (prompt) return <PromptSent prompt={prompt} label="Review prompt sent" />;
  return failed ? <PromptNotArchived /> : null;
}

function PromptNotArchived() {
  return (
    <PromptSentCard label="Review prompt sent">
      <p className="text-small text-muted">Prompt not archived.</p>
    </PromptSentCard>
  );
}

export function CriticSessions({ attempts, run, model, baseDir }: { attempts: VerificationAttempt[]; run?: AttemptSummary; model?: string; baseDir?: string }) {
  const sessions = attempts.filter((a) => a.mechanism === 'critic');
  if (sessions.length === 0) return null;
  const criticName = model ?? (run ? criticModel(run) : null) ?? 'critic';
  return (
    <div className="flex flex-col gap-2">
      {sessions.map((c, i) => (
        <div key={c.id}>
          {c.promptLocator ? <ResolvedPrompt attemptId={c.attemptId} locator={c.promptLocator} /> : <PromptNotArchived />}
          {c.hasTranscript && <CriticSession attemptId={c.id} model={criticName} agent={c.harness ? harnessLabel(c.harness) : 'Critic'} label={sessions.length > 1 ? `Critic ${i + 1} of ${sessions.length} · ${c.verdict}` : 'Critic'} baseDir={baseDir} />}
        </div>
      ))}
    </div>
  );
}

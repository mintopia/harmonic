import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { stepLabel, stepLogSource } from '../../attempt-timeline-model.js';
import type { Step, RunLogEvent } from '../../types.js';
import { sectionLabel } from '../../ui.js';
import { TranscriptTimeline } from '../TranscriptTimeline.js';

type Loaded =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'output'; summary: string; output: string }
  | { status: 'critic'; events: RunLogEvent[] };

/** The selected timeline row's own log in the main pane: a verify command's
 * captured output, or the critic's native session transcript (ADR-0040).
 * Implementation rows have no pane of their own — the Run transcript below
 * already is their ACP event stream. */
export function StepLog({ step }: { step: Step }) {
  const source = stepLogSource(step);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

  useEffect(() => {
    if (!source || source.kind === 'run') return;
    let live = true;
    setLoaded({ status: 'loading' });
    const request =
      source.kind === 'output'
        ? api.verificationAttempt(source.verificationAttemptId).then<Loaded>(({ summary, output }) => ({ status: 'output', summary, output }))
        : api.criticLog(source.verificationAttemptId).then<Loaded>((log) =>
            log.status === 'available' && log.events.length > 0 ? { status: 'critic', events: log.events } : { status: 'unavailable' },
          );
    request.then((next) => live && setLoaded(next), () => live && setLoaded({ status: 'unavailable' }));
    return () => {
      live = false;
    };
  }, [source]);

  if (!source || source.kind === 'run') return null;
  return (
    <div className="mt-6">
      <div className="flex items-center gap-2">
        <span className={sectionLabel}>Step log</span>
        <span className="text-small text-muted">{stepLabel(step)}</span>
      </div>
      <div className="mt-3">
        {loaded.status === 'loading' && <p className="text-small text-muted">Loading log…</p>}
        {loaded.status === 'unavailable' && <p className="text-small text-muted">Log unavailable.</p>}
        {loaded.status === 'output' && (
          <>
            {loaded.summary && <p className="mb-2 text-small text-muted">{loaded.summary}</p>}
            <pre className="max-h-[480px] overflow-auto rounded-lg border border-hairline bg-sunken px-3 py-2 font-data text-[12px] leading-relaxed text-ink">
              {loaded.output || '(no output)'}
            </pre>
          </>
        )}
        {loaded.status === 'critic' && (
          <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
            <TranscriptTimeline events={loaded.events} />
          </div>
        )}
      </div>
    </div>
  );
}

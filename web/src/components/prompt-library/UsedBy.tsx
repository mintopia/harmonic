import { api } from '../../api';
import { runningNow, ticketsLabel, usedByRows } from '../../prompt-library-model';
import type { Prompt } from '../../types';
import { useAsyncResource } from '../../useAsyncResource';
import { usePromptsFlow } from './PromptsFlow';

const LINE = 'text-small text-muted';
const LINK = 'font-semibold text-accent hover:text-accent-hot';

export function UsedBy({ prompt }: { prompt: Prompt | null }) {
  const flow = usePromptsFlow();
  const workflows = useAsyncResource(() => api.workflows(), []);
  if (!prompt) return <p data-testid="used-by" className={LINE}>Not used by anything until you save it.</p>;

  const rows = usedByRows(prompt, flow.prompts);
  if (rows.length === 0) return <p data-testid="used-by" className={LINE}>Nothing uses this prompt yet.</p>;

  return (
    <p data-testid="used-by" className={LINE}>
      Used by{' '}
      {rows.map((row, i) => (
        <span key={row.kind === 'step' ? `step:${row.workflow}:${row.stepId}` : `prompt:${row.code}`}>
          {i > 0 && ', '}
          {row.kind === 'step' ? (
            <a data-used-by="step" href="/workflows" className={LINK}>
              {row.workflow} · <code className="font-data">{row.stepId}</code>
            </a>
          ) : (
            <button
              type="button"
              data-used-by="prompt"
              title={`Includes ${prompt.code}${row.line !== null ? ` on line ${row.line}` : ''}`}
              onClick={() => flow.pick(row.code)}
              className={`${LINK} font-data`}
            >
              {row.code}
            </button>
          )}
        </span>
      ))}
      {workflows.data && (
        <>
          {' · '}
          <span data-testid="running-now" className="whitespace-nowrap rounded-full bg-running-tint px-2 py-0.5 font-semibold text-running">
            {ticketsLabel(runningNow(prompt, flow.prompts, workflows.data.workflows))} running now
          </span>
        </>
      )}
      <span className="mt-0.5 block text-micro">Saving changes their next execution. Prompts already sent stay as archived.</span>
    </p>
  );
}

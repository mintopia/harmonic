import { api } from '../../api';
import { runningNow, ticketsLabel, usedByRows } from '../../prompt-library-model';
import { labelType } from '../../ui';
import { useAsyncResource } from '../../useAsyncResource';
import { usePromptsFlow } from './PromptsFlow';
import { PromptHeader } from './PromptHeader';

const LINK = 'whitespace-nowrap text-body font-semibold text-accent hover:text-accent-hot';

export function PromptImpact() {
  const flow = usePromptsFlow();
  const prompt = flow.current;
  const workflows = useAsyncResource(() => api.workflows(), []);
  if (!prompt) return <p className="text-muted">A new prompt is not used by anything until you save it.</p>;

  const library = workflows.data?.workflows ?? [];
  const rows = usedByRows(prompt, flow.prompts);
  const running = runningNow(prompt, library);
  const detail = (workflow: string, bundled: boolean) => {
    const entry = library.find((w) => w.name === workflow);
    return `${bundled ? 'Bundled' : 'Your'} workflow${entry ? ` · ${ticketsLabel(entry.inUse.tickets)}` : ''}`;
  };

  return (
    <section aria-label={`Impact of ${prompt.code}`} className="flex min-w-0 flex-col gap-4">
      <PromptHeader />
      <article className="flex flex-col gap-2.5 rounded-lg bg-surface p-[18px] shadow-card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-title font-semibold">
              <span className="text-muted">3 ·</span> Used by
            </h3>
            <p className="mt-1 text-body text-muted">Saving changes the next execution of each of these. Prompts already sent stay as archived.</p>
          </div>
          {workflows.data && (
            <span data-testid="running-now" className="shrink-0 rounded-full bg-await-tint px-2.5 py-0.5 text-small font-semibold text-await">
              {ticketsLabel(running)} running now
            </span>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="text-muted">Nothing uses this prompt yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {rows.map((row) => (
              <li
                key={row.kind === 'step' ? `step:${row.workflow}:${row.stepId}` : `prompt:${row.code}`}
                data-used-by={row.kind}
                className="grid grid-cols-[70px_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-hairline px-3.5 py-3"
              >
                <span className={`${labelType} text-muted`}>{row.kind === 'step' ? 'Step' : 'Prompt'}</span>
                {row.kind === 'step' ? (
                  <>
                    <span className="min-w-0">
                      <b>{row.workflow}</b> · step <code className="font-data">{row.stepId}</code>
                      <span className="block text-micro text-muted">{detail(row.workflow, row.bundled)}</span>
                    </span>
                    <a href="/workflows" className={LINK}>
                      Open workflow
                    </a>
                  </>
                ) : (
                  <>
                    <span className="min-w-0">
                      <code className="font-data font-bold">{row.code}</code>
                      <span className="block text-micro text-muted">
                        Includes {prompt.code}
                        {row.line !== null && ` on line ${row.line}`}
                      </span>
                    </span>
                    <button type="button" onClick={() => flow.pick(row.code)} className={LINK}>
                      Open prompt
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </article>
    </section>
  );
}

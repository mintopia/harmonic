import { useState } from 'react';
import { cardTitle } from '../../board-sections-model';
import { Markdown } from '../Markdown';
import { sectionCaps } from './shared';

export function descriptionBody(prompt: string): string {
  const title = cardTitle(prompt);
  let body = prompt.trimStart();
  if (body.startsWith(title)) body = body.slice(title.length);
  body = body.replace(/^[\s]*#{1,6}[^\n]*\n+/, '').trim();
  return body || prompt;
}

export function Description({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  const body = descriptionBody(prompt);
  return (
    <div className="mb-[18px] mt-1">
      <div
        className={`text-[14.5px] leading-relaxed text-ink ${expanded ? '' : 'line-clamp-3'} [&_code]:rounded-[5px] [&_code]:bg-raised [&_code]:px-[5px] [&_code]:py-px [&_code]:text-[12.5px]`}
      >
        <Markdown source={body} className="text-ink" />
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1.5 text-[12.5px] font-semibold text-accent transition-colors hover:text-ink"
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}

/** The exact prompt a Step's work was driven by — the implementation prompt sent
 * to the harness, or the review prompt sent to the critic — verbatim and
 * monospaced, clamped when long. Distinct from {@link Description} (the ticket's
 * own body): this is what actually went to the agent. */
export function PromptSent({ prompt, label = 'Prompt sent' }: { prompt: string; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const clampable = prompt.length > 320;
  return (
    <div className="mt-4 rounded-lg border border-hairline bg-surface p-4 shadow-card">
      <div className={`mb-2 ${sectionCaps}`}>{label}</div>
      <pre className={`overflow-x-auto whitespace-pre-wrap break-words font-data text-[12.5px] leading-[1.55] text-muted ${clampable && !expanded ? 'line-clamp-[8]' : ''}`}>
        {prompt}
      </pre>
      {clampable && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-[12.5px] font-semibold text-accent transition-colors hover:text-ink"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

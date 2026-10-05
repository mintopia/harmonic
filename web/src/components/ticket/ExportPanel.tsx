import { exportPanelModel, type DestinationRow, type ExportSummaryView } from '../../task-export-model';
import { btnGhost, btnPrimary, card, statePill, statePillShape } from '../../ui';
import { CopyButton } from '../CopyButton';
import { Icon } from '../Icon';
import type { ExportTarget } from '../../export-targets';
import { useExport } from '../useExport';
import { humanState, sectionCaps, StatePill } from './shared';

function stamp(iso: string): string {
  const at = new Date(iso);
  const date = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${date} · ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`;
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

const SEP = (
  <span aria-hidden className="text-edge-strong">
    ·
  </span>
);

function Destination({ row }: { row: DestinationRow }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className={`mt-px grid size-[18px] shrink-0 place-items-center rounded-sm ${row.ok ? 'bg-merged-tint text-merged' : 'bg-fail-tint text-fail'}`}
      >
        <Icon name={row.ok ? 'check' : 'close'} className="size-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="text-data font-semibold sm:w-[74px]">{row.label}</span>
          {row.location && <span className="font-data text-small text-muted [overflow-wrap:anywhere]">{row.location}</span>}
        </div>
        {row.error && (
          <div role="alert" className="mt-1 text-small text-fail sm:ml-[86px]">
            <span className="font-data text-micro [overflow-wrap:anywhere]">{row.error}</span>
            {row.retryText && (
              <span className={`ml-2 ${row.retryExhausted ? 'font-semibold text-fail' : 'text-muted'}`}>
                <span aria-hidden className="mr-2 text-edge-strong">
                  ·
                </span>
                {row.retryText}
              </span>
            )}
          </div>
        )}
      </div>
      <span className={`inline-flex items-center gap-[5px] whitespace-nowrap text-small font-semibold ${row.ok ? 'text-merged' : 'text-fail'}`}>
        <Icon name={row.ok ? 'check' : 'close'} className="size-3" />
        {row.statusLabel}
        {row.ok && <span className="ml-[3px] text-small font-normal tabular-nums text-muted">{shortTime(row.lastAttemptAt)}</span>}
      </span>
    </li>
  );
}

function Latest({ latest, noun }: { latest: ExportSummaryView; noun: string }) {
  return (
    <>
      {latest.name && (
        <div className="mt-3 flex items-center gap-1.5 break-words text-data">
          <span className="font-data">{latest.name}</span>
          <CopyButton text={latest.name} label="Copy tarball name" className="size-7 text-muted hover:bg-raised" />
        </div>
      )}
      <p className="mt-0.5 flex flex-wrap gap-x-2 text-small text-muted">
        <span>
          Built <span className="tabular-nums">{stamp(latest.builtAt)}</span>
        </span>
        {latest.size && (
          <>
            {SEP}
            <span>{latest.size}</span>
          </>
        )}
        {latest.redactions && (
          <>
            {SEP}
            <span>
              {latest.redactions.label}
              {latest.redactions.breakdown && (
                <>
                  {' '}
                  · <span className="font-data text-micro">{latest.redactions.breakdown}</span>
                </>
              )}
            </span>
          </>
        )}
      </p>
      {latest.partial && (
        <div className="mt-3 flex items-start gap-2 rounded-sm bg-running-tint px-3 py-2 text-small text-ink">
          <Icon name="alert-triangle" className="mt-0.5 size-3.5 shrink-0 text-running" />
          <span>
            Built from surviving records; some transcripts unavailable. This {noun} predates the Archive, so its Harness logs were read from disk where
            they still existed.
          </span>
        </div>
      )}
      {latest.destinations.length > 0 && (
        <div className="mt-4 border-t border-hairline pt-3.5">
          <div className={`mb-2.5 ${sectionCaps}`}>Destinations</div>
          <ul className="flex flex-col gap-3 pb-3.5">
            {latest.destinations.map((row) => (
              <Destination key={row.key} row={row} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * The Export panel of a finished Task or Epic: the latest Export with
 * per-Destination delivery status, Export again and Download. Rendered only
 * once the Task is done or cancelled, or the Epic is done.
 */
export function ExportPanel({
  target,
  finished,
  refreshKey,
}: {
  target: ExportTarget;
  finished: boolean;
  /** Changes whenever the page's timeline gains a fact, so the panel re-reads. */
  refreshKey: number;
}) {
  const { status, busy, feedback, exportAgain, now } = useExport(target, finished, refreshKey);
  const model = exportPanelModel(status, now);
  if (!finished || model === null) return null;
  const { latest, earlier } = model;

  return (
    <div className="mb-[22px]">
      <section aria-labelledby="export-heading" id="export-panel" className={`${card} px-5 pb-1.5 pt-[18px]`}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="export-heading" className="mr-0.5 text-title font-semibold text-ink">
            Export
          </h2>
          {latest?.partial && <span className={`${statePillShape} bg-running-tint text-running`}>partial</span>}
          {latest && <StatePill state={latest.disposition} />}
          {model.totalLabel && <span className="text-small text-faint">{model.totalLabel}</span>}
          <span className="ml-auto" />
          <button type="button" className={`${btnGhost} gap-1.5`} disabled={busy} aria-busy={busy} onClick={exportAgain}>
            <Icon name="refresh" className={`size-4 ${busy ? 'motion-safe:animate-spin' : ''}`} />
            {busy ? 'Exporting…' : 'Export again'}
          </button>
          <a href={target.downloadUrl} download className={`${btnPrimary} gap-1.5 no-underline`}>
            <Icon name="download" className="size-4" />
            Download
          </a>
        </div>
        <div aria-live="polite">
          {feedback && (
            <p
              role={feedback.kind === 'error' ? 'alert' : 'status'}
              className={`mt-3 rounded-sm px-3 py-2 text-small ${feedback.kind === 'error' ? 'bg-fail-tint text-fail' : 'bg-merged-tint text-merged'}`}
            >
              {feedback.message}
            </p>
          )}
        </div>
        {latest ? (
          <Latest latest={latest} noun={target.noun} />
        ) : (
          <p className="mt-3 pb-3.5 text-small text-muted">Nothing has been exported for this {target.noun} yet. Export again builds one, or Download saves a copy.</p>
        )}
        {earlier.length > 0 && (
          <details className="group border-t border-hairline">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-small [&::-webkit-details-marker]:hidden">
              <Icon name="chevron-down" className="size-3 -rotate-90 text-faint transition-transform duration-150 group-open:rotate-0" />
              <span className="font-semibold text-muted">Earlier Exports ({earlier.length})</span>
              <span className="ml-auto" />
              <span className={statePill(earlier[0]!.disposition)}>{humanState(earlier[0]!.disposition)}</span>
              <span className="text-small tabular-nums text-faint">{stamp(earlier[0]!.builtAt)}</span>
            </summary>
            <ul className="flex flex-col gap-3 pb-3.5 pl-5 text-small">
              {earlier.map((e) => (
                <li key={e.builtAt} className="flex flex-col gap-0.5">
                  {e.name && <span className="break-all font-data text-micro">{e.name}</span>}
                  <span className="text-small text-muted">
                    {[e.size, e.deliverySummary].filter(Boolean).join(' · ')}
                    {e.partial ? ' · partial' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

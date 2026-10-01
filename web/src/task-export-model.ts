import { taskLabel } from './id-format.js';
import type { ExportDestinationKind, ExportDestinationStatus, ExportSummary, TaskExportAgainResult, TaskExportStatus } from './types.js';

export const DESTINATION_LABEL: Record<ExportDestinationKind, string> = { directory: 'Directory', s3: 'S3' };

/** Minutes before each scheduled retry of a failed Export Destination (5 min, 30 min, 2 h). */
const RETRY_DELAY_MIN = [5, 30, 120] as const;
const RETRY_MAX = RETRY_DELAY_MIN.length;

export function destinationLabel(destination: string): string {
  return destination === 'directory' || destination === 's3' ? DESTINATION_LABEL[destination] : destination;
}

export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 1) return 'under a minute';
  if (minutes < 120) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

export interface RedactionSummary {
  count: number;
  label: string;
  breakdown: string;
}

export function redactionSummary(redactions: Record<string, number> | null): RedactionSummary | null {
  if (redactions === null) return null;
  const entries = Object.entries(redactions).filter(([, n]) => n > 0);
  const count = entries.reduce((sum, [, n]) => sum + n, 0);
  return {
    count,
    label: `${count} ${count === 1 ? 'redaction' : 'redactions'}`,
    breakdown: entries.map(([name, n]) => `${name} ${n}`).join(', '),
  };
}

/** Split `AccessDenied: s3:PutObject` into the short code and the remainder. */
export function splitExportError(error: string | null): { code: string | null; rest: string | null } {
  if (error === null) return { code: null, rest: null };
  const trimmed = error.replace(/\s+/g, ' ').trim();
  const match = /^([A-Za-z][\w.-]*):\s+(.+)$/.exec(trimmed);
  if (match) return { code: match[1]!, rest: match[2]! };
  return { code: null, rest: trimmed.length > 0 ? trimmed : null };
}

export interface DestinationRow {
  key: string;
  destination: ExportDestinationKind;
  label: string;
  location: string | null;
  ok: boolean;
  statusLabel: string;
  lastAttemptAt: string;
  error: string | null;
  retryText: string | null;
  retryExhausted: boolean;
}

function retryText(retry: NonNullable<ExportDestinationStatus['retry']>, now: number): { text: string; exhausted: boolean } {
  if (retry.exhausted) return { text: 'Retries exhausted', exhausted: true };
  const upcoming = Math.min(retry.count + 1, retry.max);
  const at = retry.nextRetryAt === null ? Number.NaN : Date.parse(retry.nextRetryAt);
  if (Number.isNaN(at)) return { text: `Retry ${upcoming} of ${retry.max} pending`, exhausted: false };
  const minutes = Math.max(0, Math.ceil((at - now) / 60_000));
  return { text: `Retry ${upcoming} of ${retry.max} ${minutes === 0 ? 'due now' : `in ${formatMinutes(minutes)}`}`, exhausted: false };
}

export function destinationRow(d: ExportDestinationStatus, now: number): DestinationRow {
  const ok = d.status === 'succeeded';
  const retry = !ok && d.retry ? retryText(d.retry, now) : null;
  return {
    key: d.destination,
    destination: d.destination,
    label: destinationLabel(d.destination),
    location: d.location,
    ok,
    statusLabel: ok ? 'Delivered' : 'Failed',
    lastAttemptAt: d.lastAttemptAt,
    error: ok ? null : (d.error ?? 'Delivery failed'),
    retryText: retry?.text ?? null,
    retryExhausted: retry?.exhausted ?? false,
  };
}

export interface ExportSummaryView {
  name: string | null;
  disposition: string;
  builtAt: string;
  size: string | null;
  redactions: RedactionSummary | null;
  partial: boolean;
  destinations: DestinationRow[];
}

function summaryView(summary: ExportSummary, now: number): ExportSummaryView {
  return {
    name: summary.name,
    disposition: summary.disposition,
    builtAt: summary.builtAt,
    size: formatBytes(summary.bytes),
    redactions: redactionSummary(summary.redactions),
    partial: summary.partial,
    destinations: summary.destinations.map((d) => destinationRow(d, now)),
  };
}

export interface EarlierExportView extends ExportSummaryView {
  deliverySummary: string;
}

export interface ExportPanelModel {
  latest: ExportSummaryView | null;
  earlier: EarlierExportView[];
  /** The count shown beside the heading ("latest of 2"); null when there is at most one. */
  totalLabel: string | null;
}

/** Null when the Task is not exportable (not yet terminal) — the panel is not rendered at all. */
export function exportPanelModel(status: TaskExportStatus | null, now: number): ExportPanelModel | null {
  if (status === null || !status.exportable) return null;
  const earlier = status.earlier.map((s): EarlierExportView => {
    const view = summaryView(s, now);
    return { ...view, deliverySummary: view.destinations.map((d) => `${d.label} ${d.ok ? 'delivered' : 'failed'}`).join(' · ') };
  });
  const total = earlier.length + (status.latest ? 1 : 0);
  return {
    latest: status.latest ? summaryView(status.latest, now) : null,
    earlier,
    totalLabel: total > 1 ? `latest of ${total}` : null,
  };
}

export interface ExportFeedback {
  kind: 'success' | 'error';
  message: string;
}

export function exportAgainFeedback(result: TaskExportAgainResult): ExportFeedback {
  const failed = result.outcomes.filter((o) => o.status === 'failed');
  if (failed.length === 0) {
    return { kind: 'success', message: `Export delivered to ${result.outcomes.map((o) => destinationLabel(o.destination)).join(' and ')}.` };
  }
  const detail = failed.map((o) => `${destinationLabel(o.destination)}: ${splitExportError(o.error).code ?? o.error ?? 'failed'}`).join('; ');
  return { kind: 'error', message: `Export failed for ${detail}. Retries are scheduled.` };
}

export function clipText(value: string | null, max = 160): string | null {
  if (value === null) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export interface ExportFactRow {
  label: string;
  detail: string | null;
  tone: 'neutral' | 'passed' | 'failed';
  tag: 'EXPORT';
  /** Set on the synthetic "Export built" row, which happened before its first delivery. */
  at?: number;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function failedRetrySentence(retry: number): string {
  const next = RETRY_DELAY_MIN[retry];
  if (retry === 0) return `Retry 1 of ${RETRY_MAX} in ${formatMinutes(RETRY_DELAY_MIN[0])}.`;
  const done = `Retry ${Math.min(retry, RETRY_MAX)} of ${RETRY_MAX}.`;
  return next === undefined ? `${done} Retries exhausted.` : `${done} Next: retry ${retry + 1} of ${RETRY_MAX} in ${formatMinutes(next)}.`;
}

/** Timeline rows for one recorded `export` lifecycle fact; the first fact of a build is preceded by an "Export built" row. */
export function exportFactRows(payload: Record<string, unknown>, builtAlreadyShown: boolean): ExportFactRow[] {
  const destination = destinationLabel(str(payload.destination) ?? 'destination');
  const rows: ExportFactRow[] = [];
  const name = str(payload.name);
  const builtAt = str(payload.builtAt);
  if (!builtAlreadyShown && name !== null && builtAt !== null) {
    const parsed = Date.parse(builtAt);
    const redactions = redactionSummary(
      payload.redactions !== null && typeof payload.redactions === 'object' ? (payload.redactions as Record<string, number>) : null,
    );
    const parts = [name, formatBytes(typeof payload.bytes === 'number' ? payload.bytes : null), redactions?.label ?? null].filter((p): p is string => p !== null);
    rows.push({ label: 'Export built', detail: parts.join(' · '), tone: 'neutral', tag: 'EXPORT', ...(Number.isNaN(parsed) ? {} : { at: parsed }) });
  }
  if (payload.status === 'failed') {
    const { code, rest } = splitExportError(str(payload.error));
    const retry = typeof payload.retry === 'number' ? payload.retry : 0;
    const sentence = failedRetrySentence(retry);
    const cause = clipText(rest);
    rows.push({
      label: `Export failed · ${destination}${code ? ` — ${code}` : ''}`,
      detail: cause ? `${cause.replace(/\.$/, '')}. ${sentence}` : sentence,
      tone: 'failed',
      tag: 'EXPORT',
    });
  } else {
    rows.push({ label: `Export delivered · ${destination}`, detail: str(payload.file), tone: 'passed', tag: 'EXPORT' });
  }
  return rows;
}

function exportRetryText(retry: number, nextRetryAt: string | null): string {
  if (nextRetryAt === null) return retry === 0 ? 'not retried' : 'retries exhausted';
  const minutes = Math.max(1, Math.round((Date.parse(nextRetryAt) - Date.now()) / 60_000));
  return minutes >= 120 ? `retrying in ${Math.round(minutes / 60)} h` : `retrying in ${minutes} min`;
}

/** Toast text for a pushed `export_failed`: names the Task or Epic that was being exported. */
export function exportFailedMessage(msg: { taskId: number | null; epicRef: number | null; destination: string; retry: number; nextRetryAt: string | null }): string {
  const subject = msg.taskId !== null ? taskLabel(msg.taskId) : `Epic #${msg.epicRef}`;
  return `Export of ${subject} to ${msg.destination} failed — ${exportRetryText(msg.retry, msg.nextRetryAt)}`;
}

import { dirname } from 'node:path';
import type { ExportDestination, ExportRecord } from './task-archive.js';

export const EXPORT_RETRY_MAX = 3;

export interface PendingRetry {
  destination: ExportDestination;
  base: string;
  retries: number;
  nextRetryAt: string;
}

export interface ExportRetryStatus {
  count: number;
  max: number;
  nextRetryAt: string | null;
  exhausted: boolean;
}

export interface ExportDestinationStatus {
  destination: ExportDestination;
  location: string | null;
  status: 'succeeded' | 'failed';
  lastAttemptAt: string;
  file: string | null;
  error: string | null;
  retry: ExportRetryStatus | null;
}

export interface ExportSummary {
  name: string | null;
  disposition: string;
  builtAt: string;
  bytes: number | null;
  partial: boolean;
  redactions: Record<string, number> | null;
  destinations: ExportDestinationStatus[];
}

export interface ExportStatus {
  latest: ExportSummary | null;
  earlier: ExportSummary[];
}

function groupKey(record: ExportRecord): string {
  return record.builtAt ?? record.at;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function summarise(
  group: ExportRecord[],
  locations: ReadonlyMap<ExportDestination, string>,
  pending: readonly PendingRetry[],
): ExportSummary {
  const first = group[0]!;
  const named = group.find((r) => r.name !== undefined)?.name;
  const delivered = group.find((r) => r.status === 'succeeded' && r.file !== null)?.file;
  const name = named ?? (delivered ? basename(delivered) : null);
  const meta = group.find((r) => r.partial !== undefined || r.bytes !== undefined);
  const latestByDestination = new Map<ExportDestination, ExportRecord>();
  for (const record of group) latestByDestination.set(record.destination, record);
  const destinations = [...latestByDestination.values()].map((record): ExportDestinationStatus => {
    const waiting =
      record.status === 'failed'
        ? pending.find((p) => p.destination === record.destination && (name === null || `${p.base}.tar.gz` === name))
        : undefined;
    return {
      destination: record.destination,
      location: (record.destination === 'directory' && record.status === 'succeeded' && record.file ? dirname(record.file) : null) ?? locations.get(record.destination) ?? null,
      status: record.status,
      lastAttemptAt: record.at,
      file: record.file,
      error: record.error ?? null,
      retry:
        record.status === 'failed'
          ? { count: waiting?.retries ?? record.retry ?? 0, max: EXPORT_RETRY_MAX, nextRetryAt: waiting?.nextRetryAt ?? null, exhausted: waiting === undefined }
          : null,
    };
  });
  return {
    name,
    disposition: first.disposition,
    builtAt: groupKey(first),
    bytes: meta?.bytes ?? null,
    partial: meta?.partial ?? false,
    redactions: meta?.redactions ?? null,
    destinations,
  };
}

export function buildExportStatus(
  history: readonly ExportRecord[],
  locations: ReadonlyMap<ExportDestination, string>,
  pending: readonly PendingRetry[],
): ExportStatus {
  const groups = new Map<string, ExportRecord[]>();
  for (const record of history) {
    const key = groupKey(record);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  const summaries = [...groups.values()].map((group) => summarise(group, locations, pending));
  const latest = summaries.pop() ?? null;
  return { latest, earlier: summaries.reverse() };
}

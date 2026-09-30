import { describe, expect, it } from 'vitest';
import { exportAgainFeedback, exportPanelModel, formatBytes, redactionSummary, splitExportError } from '../web/src/task-export-model.js';
import type { ExportDestinationStatus, ExportSummary, TaskExportStatus } from '../web/src/types.js';

const NOW = Date.parse('2026-09-30T11:50:00.000Z');

const directory: ExportDestinationStatus = {
  destination: 'directory',
  location: '/srv/harmonic-exports',
  status: 'succeeded',
  lastAttemptAt: '2026-09-30T11:42:09.000Z',
  file: '/srv/harmonic-exports/412.tar.gz',
  error: null,
  retry: null,
};

const s3Failed: ExportDestinationStatus = {
  destination: 's3',
  location: 's3://acme-audit/harmonic/',
  status: 'failed',
  lastAttemptAt: '2026-09-30T11:47:12.000Z',
  file: null,
  error: 'AccessDenied: s3:PutObject',
  retry: { count: 1, max: 3, nextRetryAt: '2026-09-30T12:17:00.000Z', exhausted: false },
};

function summary(overrides: Partial<ExportSummary> = {}): ExportSummary {
  return {
    name: '412-done.tar.gz',
    disposition: 'done',
    builtAt: '2026-09-30T11:42:07.000Z',
    bytes: 19_293_798,
    partial: false,
    redactions: { 'github-token': 3, bearer: 4 },
    destinations: [directory, s3Failed],
    ...overrides,
  };
}

const status = (over: Partial<TaskExportStatus> = {}): TaskExportStatus => ({ exportable: true, latest: summary(), earlier: [], ...over });

describe('export panel model', () => {
  it('is hidden until the Task is exportable', () => {
    expect(exportPanelModel(null, NOW)).toBeNull();
    expect(exportPanelModel(status({ exportable: false }), NOW)).toBeNull();
  });

  it('describes each Destination with status, error and the upcoming retry', () => {
    const { latest } = exportPanelModel(status(), NOW)!;
    const [dir, s3] = latest!.destinations;

    expect(dir).toMatchObject({ label: 'Directory', ok: true, statusLabel: 'Delivered', error: null, retryText: null });
    expect(s3).toMatchObject({ label: 'S3', ok: false, statusLabel: 'Failed', error: 'AccessDenied: s3:PutObject', retryText: 'Retry 2 of 3 in 27 min', retryExhausted: false });
  });

  it('says retries are exhausted rather than scheduling another', () => {
    const exhausted = { ...s3Failed, retry: { count: 3, max: 3, nextRetryAt: null, exhausted: true } };
    const { latest } = exportPanelModel(status({ latest: summary({ destinations: [exhausted] }) }), NOW)!;

    expect(latest!.destinations[0]).toMatchObject({ retryText: 'Retries exhausted', retryExhausted: true });
  });

  it('summarises size, redactions, the partial flag and earlier Exports', () => {
    const model = exportPanelModel(status({ latest: summary({ partial: true }), earlier: [summary({ disposition: 'cancelled', bytes: 4_300_000, destinations: [directory] })] }), NOW)!;

    expect(model.latest).toMatchObject({ size: '18.4 MB', partial: true });
    expect(model.latest!.redactions).toEqual({ count: 7, label: '7 redactions', breakdown: 'github-token 3, bearer 4' });
    expect(model.totalLabel).toBe('latest of 2');
    expect(model.earlier[0]).toMatchObject({ disposition: 'cancelled', deliverySummary: 'Directory delivered' });
  });

  it('shows a Task that was never exported with no latest', () => {
    const model = exportPanelModel(status({ latest: null }), NOW)!;

    expect(model.latest).toBeNull();
    expect(model.totalLabel).toBeNull();
  });
});

describe('export helpers', () => {
  it('formats bytes and redactions', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(null)).toBeNull();
    expect(redactionSummary({ bearer: 1 })?.label).toBe('1 redaction');
    expect(redactionSummary(null)).toBeNull();
  });

  it('splits a leading error code from its detail', () => {
    expect(splitExportError('AccessDenied: s3:PutObject')).toEqual({ code: 'AccessDenied', rest: 's3:PutObject' });
    expect(splitExportError('s3:PutObject denied')).toEqual({ code: null, rest: 's3:PutObject denied' });
    expect(splitExportError(null)).toEqual({ code: null, rest: null });
  });

  it('gives Export again success and failure feedback', () => {
    const ok = exportAgainFeedback({ outcomes: [{ destination: 'directory', status: 'succeeded', file: 'f', error: null }], export: status() });
    const bad = exportAgainFeedback({
      outcomes: [
        { destination: 'directory', status: 'succeeded', file: 'f', error: null },
        { destination: 's3', status: 'failed', file: null, error: 'AccessDenied: s3:PutObject' },
      ],
      export: status(),
    });

    expect(ok).toEqual({ kind: 'success', message: 'Export delivered to Directory.' });
    expect(bad).toEqual({ kind: 'error', message: 'Export failed for S3: AccessDenied. Retries are scheduled.' });
  });
});

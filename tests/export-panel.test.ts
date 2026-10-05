// @vitest-environment jsdom
import { trackerRef } from '../src/tracker/adapter.js';
import { createElement } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportPanel } from '../web/src/components/ticket/ExportPanel.js';
import { epicExportTarget, taskExportTarget, type ExportTarget } from '../web/src/export-targets.js';
import type { ExportSummary, TaskExportStatus } from '../web/src/types.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const latest: ExportSummary = {
  name: '412-done.tar.gz',
  disposition: 'done',
  builtAt: '2026-09-30T11:42:07.000Z',
  bytes: 19_293_798,
  partial: false,
  redactions: { bearer: 4 },
  destinations: [
    { destination: 'directory', location: '/srv/x', status: 'succeeded', lastAttemptAt: '2026-09-30T11:42:09.000Z', file: '/srv/x/412.tar.gz', error: null, retry: null },
    {
      destination: 's3',
      location: 's3://b/p/',
      status: 'failed',
      lastAttemptAt: '2026-09-30T11:42:11.000Z',
      file: null,
      error: 'AccessDenied: s3:PutObject',
      retry: { count: 0, max: 3, nextRetryAt: new Date(Date.now() + 5 * 60_000).toISOString(), exhausted: false },
    },
  ],
};

const status = (over: Partial<TaskExportStatus> = {}): TaskExportStatus => ({ exportable: true, latest, earlier: [], ...over });

function deps(over: Partial<ExportTarget> = {}): ExportTarget {
  return {
    ...taskExportTarget(7),
    load: async () => status(),
    exportAgain: async () => ({ outcomes: [], export: status() }),
    ...over,
  };
}

async function mount(target: ExportTarget, finished = true) {
  return mountComponent(createElement(ExportPanel, { target, finished, refreshKey: 0 }));
}

describe('ExportPanel', () => {
  it('shows the latest Export, per-Destination status, error and retry, with Download', async () => {
    const host = await mount(deps());

    expect(host.textContent).toContain('412-done.tar.gz');
    expect(host.textContent).toContain('Delivered');
    expect(host.textContent).toContain('AccessDenied: s3:PutObject');
    expect(host.textContent).toMatch(/Retry 1 of 3 at \d{2}:\d{2}/);
    expect(host.querySelector('a[download]')?.getAttribute('href')).toBe('/api/tasks/7/export/download');
    expect(host.textContent).not.toContain('partial');
  });

  it('shows the partial variant', async () => {
    const host = await mount(deps({ load: async () => status({ latest: { ...latest, partial: true } }) }));

    expect(host.textContent).toContain('partial');
    expect(host.textContent).toContain('This Task predates the Archive');
  });

  it('renders nothing for an unfinished Task and does not fetch', async () => {
    const load = vi.fn(async () => status());
    const host = await mount(deps({ load }), false);

    expect(host.querySelector('#export-panel')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('runs Export again: disables the button while busy, then shows success and the refreshed status', async () => {
    let resolve!: (v: Awaited<ReturnType<ExportTarget['exportAgain']>>) => void;
    const exportAgain = vi.fn(() => new Promise<Awaited<ReturnType<ExportTarget['exportAgain']>>>((r) => (resolve = r)));
    const host = await mount(deps({ exportAgain }));
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Export again'))!;

    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Exporting');

    const refreshed = status({ latest: { ...latest, name: '412-done-2.tar.gz', destinations: [latest.destinations[0]!] } });
    await act(async () => {
      resolve({ outcomes: [{ destination: 'directory', status: 'succeeded', file: 'f', error: null }], export: refreshed });
      await flush();
    });

    expect(button.disabled).toBe(false);
    expect(host.textContent).toContain('Export delivered to Directory.');
    expect(host.textContent).toContain('412-done-2.tar.gz');
  });

  it('shows the error message inline when Export again is refused', async () => {
    const host = await mount(deps({ exportAgain: async () => Promise.reject(new Error('No Export Destination is enabled for this Task')) }));
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Export again'))!;

    await act(async () => {
      button.click();
      await flush();
    });

    expect(host.querySelector('[role=alert]')?.textContent).toContain('No Export Destination is enabled');
    expect(button.disabled).toBe(false);
  });
});

describe('ExportPanel for an Epic', () => {
  it('reads the Epic endpoints, names the Epic, and downloads from the Epic route', async () => {
    const epic = epicExportTarget(3, trackerRef(42));
    const host = await mount({ ...epic, load: async () => status({ latest: { ...latest, partial: true } }) });

    expect(host.querySelector('a[download]')?.getAttribute('href')).toBe('/api/workspaces/3/epics/42/export/download');
    expect(host.textContent).toContain('This Epic predates the Archive');
  });

  it('points the Epic target at the Epic API routes', async () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify({ exportable: true, latest: null, earlier: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const epic = epicExportTarget(3, trackerRef(42));
      await epic.load();
      await epic.exportAgain();
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toEqual(['GET /api/workspaces/3/epics/42/export', 'POST /api/workspaces/3/epics/42/export']);
  });
});

describe('ChatTranscript from Archive tag', () => {
  it('shows the tag only when the transcript is the Archive copy', async () => {
    const { ChatTranscript } = await import('../web/src/components/ticket/ChatTranscript.js');
    const render = (fromArchive: boolean) =>
      mountComponent(createElement(ChatTranscript, { events: [], unavailable: false, fromArchive, model: 'm', agent: 'Claude' }));

    expect((await render(true)).textContent).toContain('from Archive');
    await cleanup();
    expect((await render(false)).textContent).not.toContain('from Archive');
  });
});

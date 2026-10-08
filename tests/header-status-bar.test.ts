// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeaderStatusBar } from '../web/src/components/HeaderStatusBar.js';
import { cleanup, flush, makeConfig, mountComponent } from './component-smoke-harness.js';

let host: HTMLDivElement | null = null;

afterEach(cleanup);

async function renderHeader(props: {
  globalPaused: boolean;
  globalPausePending?: boolean;
  onGlobalPauseChange?: (paused: boolean) => void;
  view?: 'board' | 'conversations';
  cost24h?: string | null;
  trackerEnabled?: boolean;
  hostLoad?: { load1: number; load5: number; load15: number; cores: number; saturated: boolean } | null;
}) {
  host = await mountComponent(
    createElement(HeaderStatusBar, {
      config: makeConfig(),
      runningCount: 0,
      cost24h: props.cost24h ?? null,
      hostLoad: props.hostLoad ?? null,
      theme: 'system',
      view: props.view ?? 'board',
      passwordSet: false,
      globalPaused: props.globalPaused,
      globalPausePending: props.globalPausePending ?? false,
      trackerEnabled: props.trackerEnabled ?? false,
      refreshingTracker: false,
      menuOpen: false,
      onMenuToggle: () => {},
      onAutoRunnerChange: () => {},
      onGlobalPauseChange: props.onGlobalPauseChange ?? (() => {}),
      onRefreshTracker: () => {},
      onThemeCycle: () => {},
      onSettingsClick: () => {},
      onLogout: () => {},
      onNewTask: () => {},
      onOpenAbout: () => {},
      onOpenActivity: () => {},
    }),
  );
}

describe('HeaderStatusBar global pause control', () => {
  it('keeps the task creation control out of the mobile conversation view', async () => {
    await renderHeader({ globalPaused: false, view: 'conversations' });

    const newTask = [...host!.querySelectorAll('button')].find((item) => item.textContent?.includes('New task'));
    expect(newTask?.className).toContain('max-md:hidden');
  });

  it('pauses the fleet when it is running', async () => {
    const onGlobalPauseChange = vi.fn();
    await renderHeader({ globalPaused: false, onGlobalPauseChange });

    const button = [...host!.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Pause fleet')!;
    await act(async () => {
      button.click();
      await flush();
    });

    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(onGlobalPauseChange).toHaveBeenCalledWith(true);
  });

  it('resumes the fleet when it is paused', async () => {
    const onGlobalPauseChange = vi.fn();
    await renderHeader({ globalPaused: true, onGlobalPauseChange });

    const button = [...host!.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Resume fleet')!;
    await act(async () => {
      button.click();
      await flush();
    });

    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(onGlobalPauseChange).toHaveBeenCalledWith(false);
  });
});

describe('HeaderStatusBar compact strip', () => {
  it('stays a single-row container without flex-wrap', async () => {
    await renderHeader({ globalPaused: false });
    const header = host!.querySelector('header')!;
    expect(header.className).toContain('@container');
    expect(header.className).not.toContain('flex-wrap');
  });

  it('compacts refresh, pause, cost and load by header width', async () => {
    await renderHeader({
      globalPaused: false,
      cost24h: '$1.20',
      trackerEnabled: true,
      hostLoad: { load1: 1, load5: 2, load15: 3, cores: 4, saturated: false },
    });
    const refresh = host!.querySelector<HTMLButtonElement>('button[title^="Rescan"]')!;
    expect(refresh.querySelector('span.sr-only, span[class*="max-[82rem]:sr-only"]')?.textContent).toBe('Refresh tickets');
    const pause = host!.querySelector<HTMLButtonElement>('button[aria-label="Pause fleet"]')!;
    expect(pause.title).toBe('Pause all execution');
    expect(pause.querySelector('span[class*="max-[82rem]:sr-only"]')?.textContent).toBe('Pause');
    const cost = host!.querySelector('span[title="Cost over the last 24 hours"]')!;
    expect(cost.className).toContain('@max-[68rem]:hidden');
    const load = host!.querySelector('span[title^="Load average"]')!;
    expect(load.className).toContain('@max-[68rem]:hidden');
    expect(load.querySelector('span[class*="max-[82rem]:hidden"]')?.textContent).toContain('2.00');
    const readout = host!.querySelector('button[aria-label$="open Activity"][title]')!;
    expect(readout.getAttribute('title')).toContain('last 24h $1.20');
    expect(readout.getAttribute('title')).toContain('load 1.00 / 2.00 / 3.00');
  });
});

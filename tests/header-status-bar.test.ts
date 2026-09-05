// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeaderStatusBar } from '../web/src/components/HeaderStatusBar.js';
import { cleanup, flush, makeConfig, mountComponent } from './component-smoke-harness.js';

let host: HTMLDivElement | null = null;

afterEach(cleanup);

async function renderHeader(props: { globalPaused: boolean; globalPausePending?: boolean; onGlobalPauseChange?: (paused: boolean) => void }) {
  host = await mountComponent(
    createElement(HeaderStatusBar, {
      config: makeConfig(),
      runningCount: 0,
      cost24h: null,
      hostLoad: null,
      theme: 'system',
      view: 'board',
      passwordSet: false,
      globalPaused: props.globalPaused,
      globalPausePending: props.globalPausePending ?? false,
      onAutoRunnerChange: () => {},
      onGlobalPauseChange: props.onGlobalPauseChange ?? (() => {}),
      onThemeCycle: () => {},
      onSettingsClick: () => {},
      onLogout: () => {},
      onNewTask: () => {},
      onHelpClick: () => {},
    }),
  );
}

describe('HeaderStatusBar global pause control', () => {
  it('pauses the fleet when it is running', async () => {
    const onGlobalPauseChange = vi.fn();
    await renderHeader({ globalPaused: false, onGlobalPauseChange });

    const button = [...host!.querySelectorAll('button')].find((item) => item.textContent === 'Pause fleet')!;
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

    const button = [...host!.querySelectorAll('button')].find((item) => item.textContent === 'Resume fleet')!;
    await act(async () => {
      button.click();
      await flush();
    });

    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(onGlobalPauseChange).toHaveBeenCalledWith(false);
  });
});

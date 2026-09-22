// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AboutOverlay } from '../web/src/components/AboutOverlay.js';
import type { UpdateState } from '../web/src/types.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

let host: HTMLDivElement | null = null;

afterEach(cleanup);

function makeUpdate(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    currentVersion: '2.12.1',
    availableVersion: null,
    armedVersion: null,
    dismissedVersion: null,
    migrationRequired: false,
    idle: { runningAttempts: 0, mergingOrIntegrating: false, conversationMidTurn: false },
    ...overrides,
  };
}

async function renderAbout(props: {
  update?: UpdateState | null;
  pending?: boolean;
  onArm?: () => void;
  onCheckForUpdates?: () => void;
  onClose?: () => void;
  currentVersion?: string | null;
}) {
  host = await mountComponent(
    createElement(AboutOverlay, {
      currentVersion: 'currentVersion' in props ? props.currentVersion! : '2.12.1',
      update: props.update === undefined ? makeUpdate() : props.update,
      pending: props.pending ?? false,
      onArm: props.onArm ?? (() => {}),
      onCheckForUpdates: props.onCheckForUpdates ?? (() => {}),
      onClose: props.onClose ?? (() => {}),
    }),
  );
}

function links(): HTMLAnchorElement[] {
  return [...host!.querySelectorAll('a')];
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
}

describe('AboutOverlay', () => {
  it('renders the app name and the four expected external links', async () => {
    await renderAbout({});

    expect(host!.textContent).toContain('Harmonic');

    const hrefs = links().map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://mintopia.github.io/harmonic');
    expect(hrefs).toContain('https://github.com/mintopia/harmonic');
    expect(hrefs).toContain('https://github.com/mintopia');
    expect(hrefs).toContain('https://mintopia.net');

    for (const a of links()) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('shows the version number from currentVersion', async () => {
    await renderAbout({ currentVersion: '3.1.4' });
    expect(host!.textContent).toContain('3.1.4');
  });

  it('shows an upgrade control when a new version is available, and calls onArm when clicked', async () => {
    const onArm = vi.fn();
    await renderAbout({
      update: makeUpdate({ availableVersion: '3.2.0' }),
      onArm,
    });

    const upgradeButton = buttonByText('Update to 3.2.0')!;
    expect(upgradeButton).toBeTruthy();

    await act(async () => {
      upgradeButton.click();
      await flush();
    });

    expect(onArm).toHaveBeenCalled();
  });

  it('still shows the upgrade control for a version already dismissed on the notice banner', async () => {
    await renderAbout({
      update: makeUpdate({ availableVersion: '3.2.0', dismissedVersion: '3.2.0' }),
    });

    expect(buttonByText('Update to 3.2.0')).toBeTruthy();
  });

  it('does not show a stale upgrade button while an update is armed', async () => {
    await renderAbout({
      update: makeUpdate({ availableVersion: '3.2.0', armedVersion: '3.2.0' }),
    });

    expect(buttonByText('Update to 3.2.0')).toBeUndefined();
    expect(host!.textContent).toContain('3.2.0');
  });

  it('calls onCheckForUpdates when the check-for-updates button is clicked, and disables it while pending', async () => {
    const onCheckForUpdates = vi.fn();
    await renderAbout({ onCheckForUpdates, pending: true });

    const checkButton = buttonByText('Checking for updates')!;
    expect(checkButton.disabled).toBe(true);

    await act(async () => {
      checkButton.click();
      await flush();
    });
    expect(onCheckForUpdates).not.toHaveBeenCalled();
  });

  it('calls onCheckForUpdates when enabled', async () => {
    const onCheckForUpdates = vi.fn();
    await renderAbout({ onCheckForUpdates, pending: false });

    const checkButton = buttonByText('Check for updates')!;
    await act(async () => {
      checkButton.click();
      await flush();
    });
    expect(onCheckForUpdates).toHaveBeenCalled();
  });

  it('hides the update section entirely when update is null', async () => {
    await renderAbout({ update: null, currentVersion: null });

    expect(buttonByText('Check for updates')).toBeUndefined();
    expect(host!.textContent).toContain('Checking');
  });

  it('renders a decorative, inert layer of floating note motes behind the clef', async () => {
    await renderAbout({});

    const motes = host!.querySelectorAll('.note-mote');
    expect(motes.length).toBe(8);

    const layer = motes[0]!.parentElement!;
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.className).toContain('pointer-events-none');
  });

  it('renders the scrolling stave backdrop alongside the motes', async () => {
    await renderAbout({});
    expect(host!.querySelector('.stave-scroll')).toBeTruthy();
  });

  it('calls onClose when the modal is closed', async () => {
    const onClose = vi.fn();
    await renderAbout({ onClose });

    const closeButton = [...host!.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Close')!;
    await act(async () => {
      closeButton.click();
      await flush();
    });

    expect(onClose).toHaveBeenCalled();
  });
});

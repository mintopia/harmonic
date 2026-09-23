// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from '../web/src/components/UpdateBanner.js';
import type { UpdateState } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

let host: HTMLDivElement | null = null;

afterEach(cleanup);

function makeUpdate(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    currentVersion: '2.12.1',
    availableVersion: null,
    armedVersion: null,
    upgradingVersion: null,
    dismissedVersion: null,
    migrationRequired: false,
    guardMissing: false,
    mode: { kind: 'systemd' },
    failed: null,
    idle: { runningAttempts: 0, mergingOrIntegrating: false, conversationMidTurn: false },
    ...overrides,
  };
}

async function renderBanner(props: {
  update: UpdateState | null;
  pending?: boolean;
  onArm?: () => void;
  onCancel?: () => void;
  onDismiss?: () => void;
}) {
  host = await mountComponent(
    createElement(UpdateBanner, {
      update: props.update,
      pending: props.pending ?? false,
      onArm: props.onArm ?? (() => {}),
      onCancel: props.onCancel ?? (() => {}),
      onDismiss: props.onDismiss ?? (() => {}),
    }),
  );
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
}

describe('UpdateBanner', () => {
  it('shows the manual command for an external (npm-global) install instead of an Upgrade button', async () => {
    await renderBanner({
      update: makeUpdate({
        availableVersion: '2.13.0',
        mode: { kind: 'external', instruction: { kind: 'command', command: 'sudo npm i -g @mintopia/harmonic@2.13.0' } },
      }),
    });

    expect(host!.textContent).toContain('2.13.0');
    expect(host!.textContent).toContain('sudo npm i -g @mintopia/harmonic@2.13.0');
    expect(buttonByText('Upgrade')).toBeUndefined();
    expect(buttonByText('Dismiss')).toBeDefined();
    expect(host!.querySelector('code')).toBeTruthy();
    expect(host!.querySelector('button[aria-label="Copy command"]')).toBeTruthy();
  });

  it('copies the external command to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    await renderBanner({
      update: makeUpdate({
        availableVersion: '2.13.0',
        mode: { kind: 'external', instruction: { kind: 'command', command: 'npx @mintopia/harmonic@2.13.0 serve' } },
      }),
    });

    const copyButton = host!.querySelector('button[aria-label="Copy command"]') as HTMLButtonElement;
    expect(copyButton).toBeTruthy();
    copyButton.click();

    expect(writeText).toHaveBeenCalledWith('npx @mintopia/harmonic@2.13.0 serve');
  });

  it('shows plain instructions with no code element or copy button for an unknown-shape install', async () => {
    await renderBanner({
      update: makeUpdate({
        availableVersion: '2.13.0',
        mode: { kind: 'external', instruction: { kind: 'manual', instructions: 'reinstall @mintopia/harmonic@2.13.0 the way you originally installed it' } },
      }),
    });

    expect(host!.textContent).toContain('reinstall @mintopia/harmonic@2.13.0 the way you originally installed it');
    expect(host!.querySelector('code')).toBeNull();
    expect(host!.querySelector('button[aria-label="Copy command"]')).toBeNull();
    expect(buttonByText('Dismiss')).toBeDefined();
  });

  it('shows the failure reason and lets the operator arm again', async () => {
    const onArm = vi.fn();
    await renderBanner({
      update: makeUpdate({
        availableVersion: '2.13.0',
        failed: { targetVersion: '2.13.0', reason: 'boot guard: exceeded 3 restarts', at: new Date().toISOString() },
      }),
      onArm,
    });

    expect(host!.textContent).toContain('2.13.0');
    expect(host!.textContent).toContain('boot guard: exceeded 3 restarts');
    const tryAgain = buttonByText('Try again');
    expect(tryAgain).toBeDefined();
    tryAgain!.click();
    expect(onArm).toHaveBeenCalled();
  });

  it('does not offer the external-command banner once the version is dismissed', async () => {
    await renderBanner({
      update: makeUpdate({
        availableVersion: '2.13.0',
        dismissedVersion: '2.13.0',
        mode: { kind: 'external', instruction: { kind: 'command', command: 'npm i -g @mintopia/harmonic@2.13.0' } },
      }),
    });

    expect(host!.textContent).not.toContain('npm i -g');
  });
});

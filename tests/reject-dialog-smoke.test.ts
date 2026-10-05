// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RejectDialog } from '../web/src/components/RejectDialog.js';
import type { ContinuationPreview } from '../web/src/types.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const warmPreview = (): ContinuationPreview => ({
  available: true,
  recommended: 'continue',
  reason: 'continued-within-limits',
  contextTokens: 12,
  contextReuseTokenLimit: 100,
  continueFull: {
    session: 'same',
    conversation: 'full',
    estimate: {
      band: 'warm',
      warm: true,
      warmthKnown: true,
      estimatedWarmUntil: 1,
      msSinceActive: 1,
      msUntilCold: 1,
      note: 'Warm session.',
    },
  },
  startCondensed: {
    session: 'new',
    conversation: 'condensed',
    estimate: { band: 'cold', note: 'Fresh session.' },
  },
});

describe('RejectDialog', () => {
  it('submits empty guidance without claiming it was sent', async () => {
    const reject = vi.fn(async () => {});
    const host = await mountComponent(
      createElement(RejectDialog, {
        taskId: 7,
        onClose: () => {},
        onDone: () => {},
        reject,
        loadPreview: async (): Promise<ContinuationPreview> => ({ available: false }),
      }),
    );

    expect(host.textContent).toContain('Reject Task 7');
    expect(host.textContent).toContain('Guidance (optional)');
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Reject')!;
    expect(button.disabled).toBe(false);
    await act(async () => {
      button.click();
      await flush();
    });
    expect(reject).toHaveBeenCalledWith('', false);
  });

  it('offers a warm-session start with empty guidance', async () => {
    const reject = vi.fn(async () => {});
    const host = await mountComponent(
      createElement(RejectDialog, {
        taskId: 7,
        onClose: () => {},
        onDone: () => {},
        reject,
        loadPreview: async () => warmPreview(),
      }),
    );

    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Reject and Start Now')!;
    expect(button.disabled).toBe(false);
    await act(async () => {
      button.click();
      await flush();
    });
    expect(reject).toHaveBeenCalledWith('', true);
  });
});

describe('Reject guidance recovery', () => {
  it('keeps guidance when a dirty backdrop dismissal is cancelled', async () => {
    const onClose = vi.fn();
    const reject = vi.fn(async () => {});
    const host = await mountComponent(createElement(RejectDialog, {
      taskId: 7, onClose, onDone: () => {}, reject,
      loadPreview: async (): Promise<ContinuationPreview> => ({ available: false }),
    }));
    const textarea = host.querySelector('textarea')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(textarea, 'Add a regression test');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector('dialog')!.click());
    expect(onClose).not.toHaveBeenCalled();
    const confirm = host.querySelector('dialog[aria-label="Discard rejection guidance"]')!;
    expect(confirm).not.toBeNull();
    const cancel = [...confirm.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!;
    await act(async () => cancel.click());
    expect(textarea.value).toBe('Add a regression test');
    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Reject')!.click();
      await flush();
    });
    expect(reject).toHaveBeenCalledWith('Add a regression test', false);
  });

  it('blocks close, backdrop and Escape cancellation while the request is pending', async () => {
    const onClose = vi.fn();
    let finish: (() => void) | undefined;
    const reject = () => new Promise<void>((resolve) => { finish = resolve; });
    const onDone = vi.fn();
    const host = await mountComponent(createElement(RejectDialog, {
      taskId: 7, onClose, onDone, reject,
      loadPreview: async (): Promise<ContinuationPreview> => ({ available: false }),
    }));
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Reject')!.click());
    const dialog = host.querySelector('dialog')!;
    const cancel = new Event('cancel', { cancelable: true });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
      dialog.click();
      dialog.dispatchEvent(cancel);
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('dialog[aria-label="Discard rejection guidance"]')).toBeNull();
    await act(async () => { finish?.(); await flush(); });
    expect(onDone).toHaveBeenCalledOnce();
  });
});

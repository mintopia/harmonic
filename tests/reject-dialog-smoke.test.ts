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

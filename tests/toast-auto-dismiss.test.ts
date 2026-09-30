// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster, dismissToast, toastError, toastSuccess } from '../web/src/toast.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

const texts = () => Array.from(document.querySelectorAll('[role=status],[role=alert]')).map((e) => e.textContent);
const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

const mount = async () => {
  await mountComponent(createElement(Toaster));
  vi.useFakeTimers();
};

afterEach(async () => {
  await act(async () => {
    for (let i = 1; i < 50; i++) dismissToast(i);
  });
  vi.useRealTimers();
  await cleanup();
});

describe('toast auto-dismiss', () => {
  it('dismisses success after 6s and errors after 12s', async () => {
    await mount();
    await act(async () => {
      toastSuccess('ok-msg');
      toastError('err-msg');
    });
    await advance(5999);
    expect(texts()).toHaveLength(2);
    await advance(1);
    expect(texts()).toEqual([expect.stringContaining('err-msg')]);
    await advance(6000);
    expect(texts()).toHaveLength(0);
  });

  it('pauses on hover and focus, resumes with remaining time', async () => {
    await mount();
    await act(async () => void toastSuccess('hold'));
    await advance(4000);
    const el = document.querySelector('[role=status]')!;
    await act(async () => void el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await advance(60000);
    expect(texts()).toHaveLength(1);
    await act(async () => void el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    await advance(1999);
    expect(texts()).toHaveLength(1);
    await advance(1);
    expect(texts()).toHaveLength(0);
  });

  it('pauses on keyboard focus', async () => {
    await mount();
    await act(async () => void toastSuccess('focus'));
    const btn = document.querySelector('button[aria-label=Dismiss]') as HTMLButtonElement;
    await act(async () => btn.focus());
    await advance(60000);
    expect(texts()).toHaveLength(1);
    await act(async () => btn.blur());
    await advance(6000);
    expect(texts()).toHaveLength(0);
  });

  it('dismisses immediately on the close button', async () => {
    await mount();
    await act(async () => void toastError('bye'));
    await act(async () => void (document.querySelector('button[aria-label=Dismiss]') as HTMLButtonElement).click());
    expect(texts()).toHaveLength(0);
  });
});

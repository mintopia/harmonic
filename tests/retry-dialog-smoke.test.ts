// @vitest-environment jsdom
import { formatModelLabel } from '../web/src/components/TaskIdentity.js';
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetryDialog, type RetryBody } from '../web/src/components/RetryDialog.js';
import type { HarnessChoices } from '../web/src/components/verification-override-model.js';
import type { ContinuationPreview } from '../web/src/types.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const preview = (warm: boolean): ContinuationPreview => ({
  available: true,
  recommended: 'continue',
  reason: 'continued-within-limits',
  contextTokens: 12,
  contextReuseTokenLimit: 100,
  continueFull: {
    session: 'same',
    conversation: 'full',
    estimate: warm
      ? { band: 'warm', warm: true, warmthKnown: true, estimatedWarmUntil: 1, msSinceActive: 1, msUntilCold: 1, note: 'Warm session.' }
      : { band: 'cold', warm: false, warmthKnown: true, estimatedWarmUntil: 1, msSinceActive: 1, msUntilCold: 0, note: 'Cold session.' },
  },
  startCondensed: { session: 'new', conversation: 'condensed', estimate: { band: 'cold', note: 'Fresh session.' } },
});
const unavailable = async (): Promise<ContinuationPreview> => ({ available: false });
const groups: HarnessChoices = {
  defaultHarness: 'claude',
  byId: {
    claude: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5' },
    codex: { models: ['gpt-5-codex'], defaultModel: 'gpt-5-codex' },
  },
};
const task = { id: 7, harness: 'claude', model: 'claude-opus-5-5', routing: { label: 'reasoning', applied: true } };

const mount = (props: Partial<Parameters<typeof RetryDialog>[0]> = {}) =>
  mountComponent(
    createElement(RetryDialog, {
      task,
      onClose: () => {},
      onDone: () => {},
      retry: async () => {},
      loadPreview: unavailable,
      loadRoute: async () => groups,
      ...props,
    }),
  );
const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')];
const submitButton = (host: HTMLElement) => buttons(host).filter((b) => !b.getAttribute('role') && /^Retry/.test(b.textContent ?? '') && b.textContent !== 'Cancel').at(-1)!;
const click = (el: Element) =>
  act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
const pickRoute = async (host: HTMLElement, optionText: string, groupLabel: string) => {
  await click(host.querySelector('#retry-route')!);
  const group = host.querySelector(`[role=group][aria-label="${groupLabel}"]`)!;
  await click([...group.querySelectorAll('[role=option]')].find((b) => b.textContent?.includes(formatModelLabel(optionText)))!);
};
const retryNow = (host: HTMLElement) => click(host.querySelector('[role=radio]:not([aria-checked=true])')!);
const checkbox = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[type=checkbox]');

describe('RetryDialog', () => {
  it('queues a Retry with empty guidance and sends no route when unchanged', async () => {
    const retry = vi.fn(async (_body: RetryBody) => {});
    const host = await mount({ retry });
    expect(host.textContent).toContain('Retry #7');
    expect(host.textContent).toContain('Guidance (optional)');
    expect(host.textContent).toContain('reasoning');
    expect(submitButton(host).textContent).toBe('Retry');
    await click(submitButton(host));
    expect(retry).toHaveBeenCalledWith({ guidance: '', startNow: false });
  });

  it('hides the re-use option under Retry and when no Session exists', async () => {
    const host = await mount();
    expect(checkbox(host)).toBeNull();
    await retryNow(host);
    expect(checkbox(host)).toBeNull();
    expect(submitButton(host).textContent).toBe('Retry Now');
  });

  it('labels the button by choice and notes a warm Session', async () => {
    const retry = vi.fn(async (_body: RetryBody) => {});
    const host = await mount({ retry, loadPreview: async () => preview(true) });
    await retryNow(host);
    expect(checkbox(host)!.checked).toBe(true);
    expect(host.textContent).toContain('Session is warm: the cached context is reused.');
    expect(submitButton(host).textContent).toBe('Retry Now in this Session');
    await click(submitButton(host));
    expect(retry).toHaveBeenCalledWith({ guidance: '', startNow: true, reuseSession: true });
  });

  it('starts a fresh Session when re-use is unticked', async () => {
    const retry = vi.fn(async (_body: RetryBody) => {});
    const host = await mount({ retry, loadPreview: async () => preview(true) });
    await retryNow(host);
    await click(checkbox(host)!);
    expect(submitButton(host).textContent).toBe('Retry Now');
    await click(submitButton(host));
    expect(retry).toHaveBeenCalledWith({ guidance: '', startNow: true, reuseSession: false });
  });

  it('warns when the Session is cold but still allows re-use', async () => {
    const retry = vi.fn(async (_body: RetryBody) => {});
    const host = await mount({ retry, loadPreview: async () => preview(false) });
    await retryNow(host);
    expect(host.textContent).toContain('This Session is cold, so re-using it costs more than usual.');
    expect(host.textContent).not.toContain('Session is warm');
    await click(submitButton(host));
    expect(retry).toHaveBeenCalledWith({ guidance: '', startNow: true, reuseSession: true });
  });

  it('sends both Harness and Model when the Model changes and warns about the cost of re-use', async () => {
    const retry = vi.fn(async (_body: RetryBody) => {});
    const host = await mount({ retry, loadPreview: async () => preview(true) });
    await pickRoute(host, 'Sonnet', 'Claude');
    expect(host.textContent).toContain('Saved on this Ticket.');
    expect(host.textContent).toContain('will no longer apply.');
    await retryNow(host);
    expect(host.textContent).toContain("Switching Model in this Session costs more: the cached context can't be reused.");
    await click(submitButton(host));
    expect(retry).toHaveBeenCalledWith({ guidance: '', startNow: true, reuseSession: true, harness: 'claude', model: 'claude-sonnet-5-5' });
  });

  it('disables re-use with a reason when the Harness changes', async () => {
    const retry = vi.fn(async (_body: RetryBody) => {});
    const host = await mount({ retry, loadPreview: async () => preview(true) });
    await pickRoute(host, 'gpt-5-codex', 'Codex');
    await retryNow(host);
    expect(checkbox(host)!.disabled).toBe(true);
    expect(checkbox(host)!.checked).toBe(false);
    expect(host.textContent).toContain('Different Harness: needs a new Session.');
    expect(submitButton(host).textContent).toBe('Retry Now');
    await click(submitButton(host));
    expect(retry).toHaveBeenCalledWith({ guidance: '', startNow: true, reuseSession: false, harness: 'codex', model: 'gpt-5-codex' });
  });
});

describe('RetryDialog route picker keyboard', () => {
  const key = (el: Element, k: string) =>
    act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      await flush();
    });
  const activeText = (host: HTMLElement, list: Element) => host.querySelector(`#${CSS.escape(list.getAttribute('aria-activedescendant')!)}`)!.textContent;

  it('has no button nested in an option and moves with arrows, Home and End', async () => {
    const host = await mount();
    await click(host.querySelector('#retry-route')!);
    const list = host.querySelector('[role=listbox]')!;
    expect(list.querySelectorAll('[role=option] button').length).toBe(0);
    expect(document.activeElement).toBe(list);
    expect(activeText(host, list)).toContain(formatModelLabel('claude-opus-5-5'));
    await key(list, 'ArrowDown');
    expect(activeText(host, list)).toContain(formatModelLabel('claude-sonnet-5-5'));
    await key(list, 'End');
    expect(activeText(host, list)).toContain(formatModelLabel('gpt-5-codex'));
    await key(list, 'Home');
    expect(activeText(host, list)).toContain(formatModelLabel('claude-opus-5-5'));
  });

  it('selects the active option with Enter and closes with Escape without closing the dialog', async () => {
    const onClose = vi.fn();
    const retry = vi.fn(async (_body: RetryBody) => {});
    const host = await mount({ onClose, retry });
    await click(host.querySelector('#retry-route')!);
    await key(host.querySelector('[role=listbox]')!, 'ArrowDown');
    await key(host.querySelector('[role=listbox]')!, 'Enter');
    expect(host.querySelector('[role=listbox]')).toBeNull();
    expect(host.querySelector('#retry-route')!.textContent).toContain(formatModelLabel('claude-sonnet-5-5'));
    await click(host.querySelector('#retry-route')!);
    await key(host.querySelector('[role=listbox]')!, 'Escape');
    expect(host.querySelector('[role=listbox]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await click(submitButton(host));
    expect(retry).toHaveBeenCalledWith({ guidance: '', startNow: false, harness: 'claude', model: 'claude-sonnet-5-5' });
  });
});

describe('Retry guidance recovery', () => {
  it('keeps guidance when a dirty backdrop dismissal is cancelled', async () => {
    const onClose = vi.fn();
    const retry = vi.fn(async (_body: RetryBody) => {});
    const host = await mount({ onClose, retry });
    const textarea = host.querySelector('textarea')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(textarea, 'Add a regression test');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector('dialog')!.click());
    expect(onClose).not.toHaveBeenCalled();
    const confirm = host.querySelector('dialog[aria-label="Discard retry guidance"]')!;
    expect(confirm).not.toBeNull();
    await act(async () => [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click());
    expect(textarea.value).toBe('Add a regression test');
    await click(submitButton(host));
    expect(retry).toHaveBeenCalledWith({ guidance: 'Add a regression test', startNow: false });
  });

  it('blocks close, backdrop and Escape cancellation while the request is pending', async () => {
    const onClose = vi.fn();
    let finish: (() => void) | undefined;
    const retry = () => new Promise<void>((resolve) => { finish = resolve; });
    const onDone = vi.fn();
    const host = await mount({ onClose, onDone, retry });
    await act(async () => submitButton(host).click());
    const dialog = host.querySelector('dialog')!;
    const cancel = new Event('cancel', { cancelable: true });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
      dialog.click();
      dialog.dispatchEvent(cancel);
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish?.(); await flush(); });
    expect(onDone).toHaveBeenCalledOnce();
  });
});

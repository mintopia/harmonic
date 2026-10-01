// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));
const toastError = vi.fn();
vi.mock('../web/src/toast.js', () => ({ toastError: (e: unknown) => toastError(e) }));

import { CopyButton } from '../web/src/components/CopyButton.js';
import { ChatTranscript } from '../web/src/components/ticket/ChatTranscript.js';
import { Verification } from '../web/src/components/ticket/Verification.js';
import type { AttemptSummary, VerificationAttempt, VerifierStatus } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toastError.mockReset();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(cleanup);

const click = async (el: Element | null | undefined) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};
const button = (host: HTMLElement, label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe('CopyButton', () => {
  it('writes the text, confirms with a Copied status, then reverts', async () => {
    const host = await mountComponent(createElement(CopyButton, { text: 'hello', label: 'Copy hello' }));
    vi.useFakeTimers();
    try {
      await click(button(host, 'Copy hello'));
      expect(writeText).toHaveBeenCalledWith('hello');
      expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied');
      await act(async () => {
        vi.advanceTimersByTime(1300);
      });
      expect(host.querySelector('[role="status"]')?.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a lazy source before writing', async () => {
    const host = await mountComponent(createElement(CopyButton, { text: () => Promise.resolve('lazy text'), label: 'Copy lazy' }));
    await click(button(host, 'Copy lazy'));
    expect(writeText).toHaveBeenCalledWith('lazy text');
  });

  it('toasts and does not confirm when the clipboard is blocked', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const host = await mountComponent(createElement(CopyButton, { text: 'x', label: 'Copy x' }));
    await click(button(host, 'Copy x'));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0]![0])).toContain('denied');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it('toasts when a lazy source rejects', async () => {
    const host = await mountComponent(createElement(CopyButton, { text: () => Promise.reject(new Error('gone')), label: 'Copy y' }));
    await click(button(host, 'Copy y'));
    expect(writeText).not.toHaveBeenCalled();
    expect(String(toastError.mock.calls[0]![0])).toContain('gone');
  });
});

const run: AttemptSummary = {
  id: 1, taskId: 1, number: 1, state: 'completed', reason: null, stopReason: null, sessionId: null, prompt: null,
  branch: null, baseBranch: null, usage: null, cost: null, startedAt: 0, finishedAt: 1,
};
const attempt = (over: Partial<VerificationAttempt>): VerificationAttempt => ({
  id: 1, attemptId: 1, seq: 1, ts: 1, mechanism: 'command', inputOid: 'a'.repeat(40), verdict: 'fail', summary: 'Command failed.',
  output: 'preview', prompt: null, harness: null, hasTranscript: false, outputTruncated: false, ...over,
});

describe('copy placements', () => {
  it('copies the Critic summary as raw Markdown, not rendered text', async () => {
    const summary = '**Blocking:** missing test for `foo`.\n\n- one\n- two';
    const statuses: VerifierStatus[] = [{ mechanism: 'critic', state: 'failed', reason: null }];
    const host = await mountComponent(createElement(Verification, { attempts: [attempt({ mechanism: 'critic', summary, output: '' })], statuses, run }));
    await click(button(host, 'Copy critic summary'));
    expect(writeText).toHaveBeenCalledWith(summary);
  });

  it('copies a command result summary and its untruncated output', async () => {
    const statuses: VerifierStatus[] = [{ mechanism: 'command', state: 'failed', reason: null }];
    const host = await mountComponent(createElement(Verification, { attempts: [attempt({ output: 'line1\nline2' })], statuses, run }));
    await click(button(host, 'Copy verification result'));
    expect(writeText).toHaveBeenLastCalledWith('Command failed.');
    await click(button(host, 'Copy output'));
    expect(writeText).toHaveBeenLastCalledWith('line1\nline2');
  });

  it('fetches the full output instead of copying a truncated preview', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('FULL OUTPUT') });
    vi.stubGlobal('fetch', fetchMock);
    const statuses: VerifierStatus[] = [{ mechanism: 'command', state: 'failed', reason: null }];
    const host = await mountComponent(createElement(Verification, { attempts: [attempt({ id: 9, output: 'head…[truncated]…tail', outputTruncated: true })], statuses, run }));
    await click(button(host, 'Copy full output'));
    expect(fetchMock).toHaveBeenCalledWith('/api/verification-attempts/9/output');
    expect(writeText).toHaveBeenCalledWith('FULL OUTPUT');
  });

  it('toasts when the full output is no longer archived', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }));
    const statuses: VerifierStatus[] = [{ mechanism: 'command', state: 'failed', reason: null }];
    const host = await mountComponent(createElement(Verification, { attempts: [attempt({ id: 9, outputTruncated: true })], statuses, run }));
    await click(button(host, 'Copy full output'));
    expect(writeText).not.toHaveBeenCalled();
    expect(String(toastError.mock.calls[0]![0])).toContain('404');
  });

  it('copies an implementation agent message as raw Markdown', async () => {
    const text = 'Done. Changed `a.ts`:\n\n1. one\n2. two';
    const host = await mountComponent(
      createElement(ChatTranscript, {
        events: [{ id: 1, seq: 1, ts: 1, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }],
        unavailable: false,
        model: 'claude-sonnet-4-6',
        agent: 'Claude',
      }),
    );
    await click(button(host, 'Copy message'));
    expect(writeText).toHaveBeenCalledWith(text);
  });
});

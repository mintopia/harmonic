// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CriticSessions } from '../web/src/components/ticket/Verification.js';
import type { VerificationAttempt } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

const { resolvedPrompt, criticLog } = vi.hoisted(() => ({ resolvedPrompt: vi.fn(), criticLog: vi.fn() }));

vi.mock('../web/src/api.js', () => ({ api: { resolvedPrompt, criticLog } }));

const attempt = (over: Partial<VerificationAttempt>): VerificationAttempt => ({
  id: 1,
  attemptId: 40,
  seq: 1,
  ts: 1,
  mechanism: 'critic',
  inputOid: 'a'.repeat(40),
  verdict: 'fail',
  summary: 'blocked',
  output: '',
  promptLocator: null,
  harness: null,
  hasTranscript: false,
  outputTruncated: false,
  ...over,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
});

describe('Critic Resolved Prompts inline (#799)', () => {
  it('shows every critic attempt\'s own prompt, read through the archive-read API by locator', async () => {
    resolvedPrompt.mockImplementation(async (_id: number, locator: string) => `prompt for ${locator}`);
    const host = await mountComponent(
      createElement(CriticSessions, {
        attempts: [
          attempt({ id: 1, seq: 1, promptLocator: 'verification/pre-merge/11/prompt.md' }),
          attempt({ id: 2, seq: 2, verdict: 'pass', promptLocator: 'verification/pre-merge/12/prompt.md' }),
        ],
      }),
    );
    await flush();

    expect(resolvedPrompt).toHaveBeenCalledWith(40, 'verification/pre-merge/11/prompt.md');
    expect(resolvedPrompt).toHaveBeenCalledWith(40, 'verification/pre-merge/12/prompt.md');
    expect(host.textContent).toContain('prompt for verification/pre-merge/11/prompt.md');
    expect(host.textContent).toContain('prompt for verification/pre-merge/12/prompt.md');
  });

  it('shows an epic critic prompt with no transcript, and offers no edit control', async () => {
    resolvedPrompt.mockResolvedValue('Review epic #5');
    const host = await mountComponent(createElement(CriticSessions, { attempts: [attempt({ attemptId: 77, promptLocator: 'verification/pre-merge/3/prompt.md' })] }));
    await flush();

    expect(host.textContent).toContain('Review epic #5');
    expect(host.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
    expect(host.textContent).not.toMatch(/\bEdit\b/);
  });

  it('renders nothing for a critic attempt with no archived prompt', async () => {
    const host = await mountComponent(createElement(CriticSessions, { attempts: [attempt({})] }));
    await flush();

    expect(resolvedPrompt).not.toHaveBeenCalled();
    expect(host.textContent).toBe('');
  });
});

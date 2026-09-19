// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CriticSessions } from '../web/src/components/ticket/Verification.js';
import type { VerificationAttempt } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

const { criticLog } = vi.hoisted(() => ({
  criticLog: vi.fn(),
}));

vi.mock('../web/src/api.js', () => ({
  api: { criticLog },
}));

const criticAttempt: VerificationAttempt = {
  id: 7,
  attemptId: 1,
  seq: 1,
  ts: 1,
  mechanism: 'critic',
  inputOid: 'a'.repeat(40),
  verdict: 'pass',
  summary: 'Critic passed.',
  output: '',
  prompt: null,
  harness: null,
  hasTranscript: true,
};

afterEach(cleanup);

describe('CriticSession transcript states (#653 bug 3)', () => {
  it('renders an empty-transcript message, not "could not be loaded", when the log is available but has no events', async () => {
    criticLog.mockResolvedValueOnce({ status: 'available', events: [], liveCursor: 0 });

    const host = await mountComponent(createElement(CriticSessions, { attempts: [criticAttempt] }));

    expect(host.textContent).not.toContain('could not be loaded');
    expect(host.textContent).toContain('No critic session events recorded.');
  });

  it('surfaces a failure-specific message with the real error text when criticLog rejects', async () => {
    criticLog.mockRejectedValueOnce(new Error('boom'));

    const host = await mountComponent(createElement(CriticSessions, { attempts: [criticAttempt] }));

    expect(host.textContent).toContain('boom');
    expect(host.textContent).not.toContain('No critic session events recorded.');
    expect(host.textContent).not.toContain('could not be loaded');
  });
});

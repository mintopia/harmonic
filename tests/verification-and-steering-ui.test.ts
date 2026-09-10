// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatTranscript } from '../web/src/components/ticket/ChatTranscript.js';
import { Verification } from '../web/src/components/ticket/Verification.js';
import type { AttemptSummary, VerificationAttempt, VerifierStatus } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

const run: AttemptSummary = {
  id: 1,
  taskId: 1,
  number: 1,
  state: 'completed',
  reason: null,
  stopReason: null,
  sessionId: null,
  prompt: null,
  branch: null,
  baseBranch: null,
  usage: null,
  cost: null,
  startedAt: 0,
  finishedAt: 1,
};

const commandAttempt: VerificationAttempt = {
  id: 1,
  attemptId: 1,
  seq: 1,
  ts: 1,
  mechanism: 'command',
  inputOid: 'a'.repeat(40),
  verdict: 'pass',
  summary: 'Command passed.',
  output: 'stdout survives verification completion',
  prompt: null,
  harness: null,
  hasTranscript: false,
};

const statuses: VerifierStatus[] = [{ mechanism: 'command', state: 'passed', reason: null }];

afterEach(cleanup);

describe('verification and steering UI (#537)', () => {
  it('keeps completed command stdout visible from the persisted verification record', async () => {
    const host = await mountComponent(createElement(Verification, { attempts: [commandAttempt], statuses, run }));

    expect(host.textContent).toContain('stdout survives verification completion');
  });

  it('shows a sent steer immediately with a pending-delivery marker', async () => {
    const host = await mountComponent(
      createElement(ChatTranscript, {
        events: [],
        unavailable: false,
        pendingSteers: [{ id: 1, text: 'Please run the focused test.', at: 1 }],
        model: 'claude-sonnet-4-6',
        agent: 'Claude',
      }),
    );

    expect(host.textContent).toContain('Please run the focused test.');
    expect(host.textContent).toContain('Pending delivery');
  });

  it('replaces only the matching pending steer when the transcript records its delivery', async () => {
    const host = await mountComponent(
      createElement(ChatTranscript, {
        events: [{ id: 2, seq: 2, ts: 2, type: 'session_update', payload: { sessionUpdate: 'operator_message', content: { type: 'text', text: 'Run it.' } } }],
        unavailable: false,
        pendingSteers: [
          { id: 1, text: 'Run it.', at: 1 },
          { id: 2, text: 'Run it.', at: 1 },
        ],
        model: 'claude-sonnet-4-6',
        agent: 'Claude',
      }),
    );

    expect(host.textContent).toContain('Pending delivery');
    expect(host.textContent?.match(/Run it\./g)).toHaveLength(2);
  });

  it('clears the pending marker after subsequent agent activity', async () => {
    const host = await mountComponent(
      createElement(ChatTranscript, {
        events: [
          { id: 1, seq: 1, ts: 1, type: 'session_update', payload: { sessionUpdate: 'operator_message', pending: true, content: { type: 'text', text: 'Run it.' } } },
          { id: 2, seq: 2, ts: 2, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running it now.' } } },
        ],
        unavailable: false,
        model: 'claude-sonnet-4-6',
        agent: 'Claude',
      }),
    );

    expect(host.textContent).not.toContain('Pending delivery');
  });
});

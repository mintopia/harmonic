// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Board } from '../web/src/components/Board.js';
import { AttemptsNav } from '../web/src/components/ticket/AttemptsNav.js';
import { Properties } from '../web/src/components/ticket/Metrics.js';
import type { Attempt, Task } from '../web/src/types.js';
import { cleanup, flush, makeTask, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const squash = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const mountProps = (task: Task) => mountComponent(createElement(Properties, { task, allTasks: [task], workspaceName: 'ws' }));
const agentFact = (host: HTMLElement) => Array.from(host.querySelectorAll('dt')).find((dt) => dt.textContent === 'Agent')!.nextElementSibling!;

describe('Agent fact, classifier states', () => {
  it('routed: names the classifier and option, and reveals the reason on expand', async () => {
    const host = await mountProps(
      makeTask({ classifier: { kind: 'routed', optionId: 'opus-deep', reason: 'Touches the lease reconciler across four modules.' } }),
    );
    const fact = agentFact(host);
    expect(squash(fact)).toContain('routed by classifier');
    expect(fact.querySelector('code')?.textContent).toBe('opus-deep');
    expect(host.textContent).not.toContain('lease reconciler');
    const toggle = Array.from(fact.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Why'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      toggle.click();
      await flush();
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Touches the lease reconciler across four modules.');
  });

  it('abstained: says the classifier abstained, why, and which default ran', async () => {
    const host = await mountProps(makeTask({ classifier: { kind: 'abstained', optionId: null, reason: 'timed out after 30 s' } }));
    expect(squash(agentFact(host))).toBe(
      'Claude · Sonnet 4.6 abstained — Route Classifier abstained (timed out after 30 s); used Workspace default Claude Sonnet 4.6.',
    );
  });

  it('overridden: says an operator setting won and the classifier was not consulted', async () => {
    const host = await mountProps(makeTask({ classifier: { kind: 'overridden', optionId: null, reason: null } }));
    expect(squash(agentFact(host))).toBe('Claude · Sonnet 4.6 — set on this Ticket; the classifier was not consulted');
  });

  it('adds nothing when the classifier did not decide', async () => {
    const host = await mountProps(makeTask({ classifier: null }));
    expect(squash(agentFact(host))).toBe('Claude · Sonnet 4.6');
  });
});

describe('Board card classifier chip', () => {
  const mountBoard = (tasks: Task[]) =>
    mountComponent(createElement(Board, { tasks, epics: [], loading: false, hasHistory: true, onOpen: () => {}, onOpenTask: () => {}, onNewTask: () => {} }));

  it('shows ↳ classifier when routed, a muted default chip when abstained, and nothing otherwise', async () => {
    const host = await mountBoard([
      makeTask({ id: 1, state: 'working', classifier: { kind: 'routed', optionId: 'opus-deep', reason: 'r' } }),
      makeTask({ id: 2, state: 'working', classifier: { kind: 'abstained', optionId: null, reason: 'timed out' } }),
      makeTask({ id: 3, state: 'working', classifier: { kind: 'overridden', optionId: null, reason: null } }),
      makeTask({ id: 4, state: 'working', classifier: null }),
    ]);
    const text = host.textContent ?? '';
    expect(text.match(/↳ classifier/g)).toHaveLength(1);
    expect(text.match(/default/g)).toHaveLength(1);
  });
});

const attempt = (over: Partial<Attempt>): Attempt => ({
  id: 1, taskId: 7, number: 1, state: 'failed', startedAt: 1_000, endedAt: 3_000, feedback: null, verifiedSha: null,
  escalationReason: null, workingDir: null, harness: null, model: null, classifier: null, verifierStatuses: [], continuation: null, steps: [],
  ...over,
});

describe('Attempt history routing', () => {
  it('shows both options when Attempt 2 switched, with the reason and a cold Session note on a Harness change', async () => {
    const host = await mountComponent(
      createElement(AttemptsNav, {
        attempts: [
          attempt({ id: 1, number: 1, harness: 'claude', model: 'claude-sonnet-4-6', classifier: { kind: 'routed', optionId: 'sonnet-small', reason: 'small, well-scoped fix' } }),
          attempt({ id: 2, number: 2, state: 'running', harness: 'codex', model: 'gpt-5-codex', classifier: { kind: 'routed', optionId: 'codex-bulk', reason: 'prior Attempt failed on a race' } }),
        ],
        maxAttempts: null,
        selectedNumber: 2,
        onSelect: () => {},
      }),
    );
    const items = Array.from(host.querySelectorAll('li'));
    expect(squash(items[0])).toContain('sonnet-small');
    expect(squash(items[0])).toContain('Classifier: small, well-scoped fix');
    expect(squash(items[1])).toContain('codex-bulk');
    expect(squash(items[1])).toContain('Classifier: prior Attempt failed on a race');
    expect(squash(items[1])).toContain('Harness changed: cold Session');
    expect(squash(items[0])).not.toContain('Harness changed');
  });

  it('shows an abstained Attempt as the default and leaves unclassified Attempts bare', async () => {
    const host = await mountComponent(
      createElement(AttemptsNav, {
        attempts: [
          attempt({ id: 1, number: 1, harness: 'claude', model: 'claude-sonnet-4-6', classifier: { kind: 'abstained', optionId: null, reason: 'timed out' } }),
          attempt({ id: 2, number: 2, harness: 'claude', model: 'claude-sonnet-4-6' }),
        ],
        maxAttempts: null,
        selectedNumber: null,
        onSelect: () => {},
      }),
    );
    const items = Array.from(host.querySelectorAll('li'));
    expect(squash(items[0])).toContain('Classifier abstained: timed out');
    expect(squash(items[1])).not.toContain('Classifier');
  });
});

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
const agentFact = (host: HTMLElement) => Array.from(host.querySelectorAll('dt')).find((dt) => dt.textContent === 'Agent')!.nextElementSibling!;

type Classifier = NonNullable<Task['classifier']>;
const routed = (optionId: string, reason: string, position = 2, optionCount = 4): Attempt['classifier'] & Classifier => ({ kind: 'routed', optionId, reason, position, optionCount });
const abstained = (reason: string): Attempt['classifier'] & Classifier => ({ kind: 'abstained', optionId: null, reason, position: null, optionCount: null });
const overridden: Classifier = { kind: 'overridden', optionId: null, reason: null, position: null, optionCount: null };

const attempt = (over: Partial<Attempt>): Attempt => ({
  id: 1, taskId: 7, number: 1, state: 'failed', startedAt: 1_000, endedAt: 3_000, feedback: null,
  escalationReason: null, workingDir: null, harness: null, model: null, classifier: null, routing: null, continuation: null, stepRuns: [],
  ...over,
});
const cost = (totalUsd: number) => ({ totalUsd, byModel: {}, incomplete: false });

const mountProps = (task: Task, attempts: Attempt[] = []) =>
  mountComponent(createElement(Properties, { task, allTasks: [task], workspaceName: 'ws', attempts }));

const expand = async (host: HTMLElement) => {
  const toggle = Array.from(agentFact(host).querySelectorAll('button')).find((b) => b.textContent?.startsWith('Why'))!;
  await act(async () => {
    toggle.click();
    await flush();
  });
  return toggle;
};

describe('Agent fact, classifier states', () => {
  it('routed: names the classifier and option, and reveals the reason on expand', async () => {
    const host = await mountProps(makeTask({ classifier: routed('opus-deep', 'Touches the lease reconciler across four modules.') }));
    const fact = agentFact(host);
    expect(squash(fact)).toContain('routed by classifier');
    expect(fact.querySelector('code')?.textContent).toBe('opus-deep');
    expect(host.textContent).not.toContain('lease reconciler');
    const toggle = await expand(host);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Touches the lease reconciler across four modules.');
  });

  it('routed, expanded: shows the option position, the Attempt inputs and the routing Cost', async () => {
    const host = await mountProps(makeTask({ classifier: routed('opus-deep', 'concurrency-sensitive') }), [
      attempt({ number: 1, state: 'failed', feedback: 'lease-reconciler.test.ts flaked under load' }),
      attempt({
        id: 2, number: 2, state: 'running', classifier: routed('opus-deep', 'concurrency-sensitive'),
        routing: { cost: cost(0.04), models: ['claude-sonnet-4-6'] },
      }),
    ]);
    await expand(host);
    const text = squash(agentFact(host))!;
    expect(text).toContain('option 2 of 4');
    expect(text).toContain('2 · Attempt 1 failed: lease-reconciler.test.ts flaked under load');
    expect(text).toContain('Routing $0.04 · Sonnet 4.6');
  });

  it('routed, expanded on the first Attempt: says there is no prior verdict', async () => {
    const host = await mountProps(makeTask({ classifier: routed('opus-deep', 'r') }), [
      attempt({ number: 1, state: 'running', classifier: routed('opus-deep', 'r') }),
    ]);
    await expand(host);
    expect(squash(agentFact(host))).toContain('1 · first Attempt, no prior verdict');
  });

  it('abstained: says the classifier abstained, why, and which default ran', async () => {
    const host = await mountProps(makeTask({ classifier: abstained('timed out after 30 s') }));
    expect(squash(agentFact(host))).toBe(
      'Claude · Sonnet 4.6 abstained — Route Classifier abstained (timed out after 30 s); used Workspace default Claude Sonnet 4.6.',
    );
  });

  it('overridden: says an operator setting won and the classifier was not consulted', async () => {
    const host = await mountProps(makeTask({ classifier: overridden }));
    expect(squash(agentFact(host))).toBe('Claude · Sonnet 4.6 — set on this Ticket; the classifier was not consulted');
  });

  it('Routing Label won: says the classifier was not consulted', async () => {
    const host = await mountProps(makeTask({ routing: { label: 'reasoning', applied: true } }));
    expect(squash(agentFact(host))).toBe('Claude · Sonnet 4.6 — routed by reasoning; the classifier was not consulted');
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
      makeTask({ id: 1, state: 'working', classifier: routed('opus-deep', 'r') }),
      makeTask({ id: 2, state: 'working', classifier: abstained('timed out') }),
      makeTask({ id: 3, state: 'working', classifier: overridden }),
      makeTask({ id: 4, state: 'working', classifier: null }),
    ]);
    const text = host.textContent ?? '';
    expect(text.match(/↳ classifier/g)).toHaveLength(1);
    expect(text.match(/default/g)).toHaveLength(1);
  });
});

describe('Attempt history routing', () => {
  const mountNav = (attempts: Attempt[]) => mountComponent(createElement(AttemptsNav, { attempts, selectedNumber: null, onSelect: () => {} }));

  it('shows both options when Attempt 2 switched, with reason, routing Cost and a cold Session note on a Harness change', async () => {
    const host = await mountNav([
      attempt({
        id: 1, number: 1, harness: 'claude', model: 'claude-sonnet-4-6', classifier: routed('sonnet-small', 'small, well-scoped fix'),
        routing: { cost: cost(0.04), models: ['claude-haiku-4-5'] },
      }),
      attempt({
        id: 2, number: 2, state: 'running', harness: 'codex', model: 'gpt-5-codex', classifier: routed('codex-bulk', 'prior Attempt failed on a race'),
        routing: { cost: cost(0.05), models: ['claude-haiku-4-5'] },
      }),
    ]);
    const items = Array.from(host.querySelectorAll('li'));
    expect(squash(items[0])).toContain('sonnet-small');
    expect(squash(items[0])).toContain('Classifier: small, well-scoped fix');
    expect(squash(items[0])).toContain('Routing $0.04');
    expect(squash(items[1])).toContain('codex-bulk');
    expect(squash(items[1])).toContain('Classifier: prior Attempt failed on a race');
    expect(squash(items[1])).toContain('Routing $0.05');
    expect(squash(items[1])).toContain('Harness changed: cold Session');
    expect(squash(items[0])).not.toContain('Harness changed');
  });

  it('shows an abstained Attempt as the default and leaves unclassified Attempts bare', async () => {
    const host = await mountNav([
      attempt({ id: 1, number: 1, harness: 'claude', model: 'claude-sonnet-4-6', classifier: abstained('timed out') }),
      attempt({ id: 2, number: 2, harness: 'claude', model: 'claude-sonnet-4-6' }),
    ]);
    const items = Array.from(host.querySelectorAll('li'));
    expect(squash(items[0])).toContain('Classifier abstained: timed out');
    expect(squash(items[1])).not.toContain('Classifier');
  });
});

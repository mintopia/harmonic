// @vitest-environment jsdom
import { createElement, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useTicketPageData, type TicketPageData, type TicketPageDataDeps } from '../web/src/components/useTicketPageData.js';
import { cleanup, makeTask, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

function fakeDeps(overrides: Partial<TicketPageDataDeps> = {}): TicketPageDataDeps {
  return {
    loadAllTasks: async () => ({ tasks: [] }),
    loadTask: async (id) => makeTask({ id }),
    loadTimeline: async () => ({ events: [] }),
    loadWorkspaces: async () => ({ workspaces: [] }),
    loadGuardrailEvents: async () => ({ guardrailEvents: [] }),
    loadWorkflowSteps: async () => ({ workflowRef: null, workflowChosen: null, outline: [], cleanupCount: 0, latestVersion: null, steps: [] }),
    ...overrides,
  };
}

async function probe(taskId: number, attemptId: number | null, deps: TicketPageDataDeps): Promise<TicketPageData> {
  let latest!: TicketPageData;
  function Probe() {
    const data = useTicketPageData(makeTask({ id: taskId }), attemptId, deps);
    useEffect(() => {
      latest = data;
    });
    return null;
  }
  await mountComponent(createElement(Probe));
  return latest;
}

describe('useTicketPageData (issue #657)', () => {
  it('loads every field from injected deps — no fetch/api mocking needed', async () => {
    const task = makeTask({ id: 7, prompt: 'from detail load' });
    const data = await probe(
      7,
      null,
      fakeDeps({
        loadAllTasks: async () => ({ tasks: [task] }),
        loadTask: async () => task,
        loadTimeline: async () => ({ events: [{ id: 1, at: 0, kind: 'created', taskId: 7 } as never] }),
      }),
    );

    expect(data.allTasks).toEqual([task]);
    expect(data.detail).toEqual(task);
    expect(data.timelineEvents).toHaveLength(1);
  });

  it('derives workspaceName from the owning workspace', async () => {
    const withWorkspace = await probe(
      1,
      null,
      fakeDeps({
        loadWorkspaces: async () => ({ workspaces: [makeWorkspace({ id: 1, name: 'Payments' })] }),
      }),
    );
    expect(withWorkspace.workspaceName).toBe('Payments');

    const unmatched = await probe(
      2,
      null,
      fakeDeps({
        loadWorkspaces: async () => ({ workspaces: [makeWorkspace({ id: 999, name: 'Other' })] }),
      }),
    );
    expect(unmatched.workspaceName).toBeNull();
  });

  it('guardrailEvents is empty with no api call when no attempt is selected, and loads once one is', async () => {
    let calls = 0;
    const idle = await probe(
      1,
      null,
      fakeDeps({
        loadGuardrailEvents: async () => {
          calls++;
          return { guardrailEvents: [] };
        },
      }),
    );
    expect(idle.guardrailEvents).toEqual([]);
    expect(calls).toBe(0);

    const selected = await probe(
      1,
      5,
      fakeDeps({
        loadGuardrailEvents: async (attemptId) => {
          calls++;
          expect(attemptId).toBe(5);
          return { guardrailEvents: [{ id: 1 } as never] };
        },
      }),
    );
    expect(selected.guardrailEvents).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { planLegacyResume, type LegacyStepRow } from '../src/domain/legacy-step-resume.js';
import { parseWorkflow } from '../src/domain/workflow.js';

const implement = parseWorkflow(`name: implement
description: d
steps:
  - id: rebase
    uses: rebase
  - attempts:
      max: 3
      steps:
        - id: build
          uses: agent
        - id: verify
          uses: verify
        - id: review
          parallel:
            - id: critic
              uses: critic
              with:
                harness: claude
                model: m
                prompt: review it
  - id: merge
    uses: merge
  - id: close
    uses: close-ticket
`);

const legacy = (...pairs: [LegacyStepRow['type'], LegacyStepRow['state']][]): LegacyStepRow[] => pairs.map(([type, state]) => ({ type, state }));
const ids = (rows: { stepId: string }[]): string[] => rows.map((row) => row.stepId);

describe('planLegacyResume', () => {
  it('seeds nothing for an interrupted Attempt that never recorded a step', () => {
    expect(planLegacyResume(implement, [], 1, 3)).toEqual([]);
  });

  it('re-runs the step that was running: seeds only the steps before it', () => {
    const rows = planLegacyResume(implement, legacy(['rebase', 'passed'], ['implementation', 'passed'], ['verification', 'running']), 1, 3);
    expect(ids(rows)).toEqual(['rebase', 'build']);
    expect(rows.every((row) => row.outcome === 'pass')).toBe(true);
  });

  it('resumes after a passed step', () => {
    const rows = planLegacyResume(implement, legacy(['rebase', 'passed'], ['implementation', 'passed'], ['verification', 'passed']), 1, 3);
    expect(ids(rows)).toEqual(['rebase', 'build', 'verify']);
  });

  it('seeds the review group as one unit when the review step passed', () => {
    const rows = planLegacyResume(implement, legacy(['review', 'passed']), 1, 3);
    expect(ids(rows)).toEqual(['rebase', 'build', 'verify', 'critic']);
  });

  it('treats a review that was running as the target', () => {
    expect(ids(planLegacyResume(implement, legacy(['review', 'running']), 1, 3))).toEqual(['rebase', 'build', 'verify']);
  });

  it('gives block rows the clamped budget Attempt and rows outside it none', () => {
    const rows = planLegacyResume(implement, legacy(['review', 'passed']), 7, 3);
    expect(rows.map((row) => [row.stepId, row.attempt])).toEqual([['rebase', null], ['build', 3], ['verify', 3], ['critic', 3]]);
    expect(planLegacyResume(implement, legacy(['review', 'passed']), 0, 3).find((row) => row.stepId === 'build')?.attempt).toBe(1);
  });

  it('records where each step was carried over from, with its positions and actions', () => {
    const rows = planLegacyResume(implement, legacy(['implementation', 'passed']), 2, 3);
    expect(rows).toEqual([
      { stepId: 'rebase', position: 0, action: 'rebase', attempt: null, outcome: 'pass', summary: 'carried over from pre-workflow Attempt 2 (rebase)' },
      { stepId: 'build', position: 1, action: 'agent', attempt: 2, outcome: 'pass', summary: 'carried over from pre-workflow Attempt 2 (agent)' },
    ]);
  });

  it('seeds the failed target of an escalated Ticket as fail so Accept can flip it', () => {
    const rows = planLegacyResume(implement, legacy(['rebase', 'passed'], ['implementation', 'passed'], ['verification', 'failed']), 1, 3, true);
    expect(rows.map((row) => [row.stepId, row.outcome])).toEqual([['rebase', 'pass'], ['build', 'pass'], ['verify', 'fail']]);
  });

  it('seeds the step after a passed one as fail when an escalated Ticket stopped there', () => {
    const rows = planLegacyResume(implement, legacy(['rebase', 'passed'], ['implementation', 'passed']), 1, 3, true);
    expect(rows.map((row) => [row.stepId, row.outcome])).toEqual([['rebase', 'pass'], ['build', 'pass'], ['verify', 'fail']]);
  });

  it('seeds everything before merge for an escalation with no legacy steps', () => {
    const rows = planLegacyResume(implement, [], 1, 3, true);
    expect(rows.map((row) => [row.stepId, row.outcome])).toEqual([['rebase', 'pass'], ['build', 'pass'], ['verify', 'pass'], ['critic', 'pass']]);
  });

  it('orders run: steps with the verification ordinal and unknown actions last', () => {
    const custom = parseWorkflow(`name: c
description: d
steps:
  - id: setup
    run: echo hi
  - attempts:
      max: 1
      steps:
        - id: build
          uses: agent
  - id: ship
    uses: open-pr
`);
    expect(planLegacyResume(custom, legacy(['implementation', 'passed']), 1, 1)).toEqual([]);
    expect(ids(planLegacyResume(custom, legacy(['verification', 'passed']), 1, 1))).toEqual(['setup', 'build']);
  });
});

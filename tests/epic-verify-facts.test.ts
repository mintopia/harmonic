import { describe, expect, it } from 'vitest';
import type { WorkflowStepRunRow } from '../src/db/schema.js';
import { epicVerifyFacts } from '../src/domain/epic-verify-facts.js';
import { templateEntries } from '../src/domain/workflow-library-store.js';

const run = (stepId: string, outcome: WorkflowStepRunRow['outcome']) => [stepId, { stepId, outcome } as WorkflowStepRunRow] as const;

const withChecks = `name: e
description: t
subject: epic
vars:
  maxAttempts: 2
steps:
  - attempts:
      max: \${{ vars.maxAttempts }}
      steps:
        - id: unit
          run: npm test
        - id: review
          uses: critic
          with: { harness: claude, model: m, prompt: criticReview }
  - id: merge
    uses: merge
`;

const noChecks = `name: e
description: t
subject: epic
vars:
  maxAttempts: 1
steps:
  - attempts:
      max: 1
      steps:
        - id: only
          uses: agent
          with: { prompt: epic-resolve }
  - id: merge
    uses: merge
`;

describe('epicVerifyFacts', () => {
  it('labels the workflow check and critic steps and reads status from their latest step runs', () => {
    const none = epicVerifyFacts(withChecks, new Map());
    expect(none).toEqual({ configured: true, status: null, labels: ['npm test', 'Critic: review'] });
    expect(epicVerifyFacts(withChecks, new Map([run('unit', 'pass')])).status).toBeNull();
    expect(epicVerifyFacts(withChecks, new Map([run('unit', 'pass'), run('review', null)])).status).toBe('pending');
    expect(epicVerifyFacts(withChecks, new Map([run('unit', 'pass'), run('review', 'pass')])).status).toBe('pass');
    expect(epicVerifyFacts(withChecks, new Map([run('unit', 'fail'), run('review', 'pass')])).status).toBe('fail');
  });

  it('reports an unconfigured gate when the workflow has no check or critic step', () => {
    expect(epicVerifyFacts(noChecks, new Map())).toEqual({ configured: false, status: null, labels: [] });
  });

  it('treats the bundled epic workflow critic as its verification', () => {
    const bundled = templateEntries().find((entry) => entry.name === 'epic')!;
    expect(epicVerifyFacts(bundled.text, new Map())).toMatchObject({ configured: true, labels: ['Critic: critic'] });
  });
});

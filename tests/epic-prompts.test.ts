import { describe, expect, it, afterAll } from 'vitest';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { templateEntries } from '../src/domain/workflow-library-store.js';
import { parseWorkflow, type WorkflowStepDefinition } from '../src/domain/workflow.js';
import { buildWorkflowCriticPrompt, renderAgentPrompt } from '../src/execution/prompt-assembly.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig } from '../src/config.js';
import { convertEditedEpicFixPrompts, epicFixTexts } from '../src/domain/epic-fix-prompt.js';
import { NO_RETIRED } from '../src/domain/retired-settings.js';
import { type WorkflowStepRunRow } from '../src/db/schema.js';
import { epicVerifyFacts } from '../src/domain/epic-verify-facts.js';

function criticStepOf(text: string): WorkflowStepDefinition {
  const def = parseWorkflow(text);
  const step = [...def.steps, ...(def.cleanup ?? [])]
    .flatMap((s) => [s, ...(s.parallel ?? [])])
    .find((s) => s.uses === 'critic');
  if (!step) throw new Error('epic template has no critic step');
  return step;
}

describe('epic critic prompt (gives the critic the Epic spec, not "the Ticket")', () => {
  const epicTemplate = templateEntries().find((e) => e.name === 'epic')!;

  it('points the bundled epic template critic at criticEpic, not criticReview', () => {
    const step = criticStepOf(epicTemplate.text);
    expect(step.with?.prompt).toBe('criticEpic');
  });

  it('ships a criticEpic prompt that frames an Epic and interpolates its fields', async () => {
    const lib = new PromptLibrary(null);
    const prompt = await lib.get('criticEpic');
    expect(prompt.text).toMatch(/epic/i);
    // Uses the Epic's own fields rather than a single ticket.
    for (const field of ['{ref}', '{title}', '{description}']) {
      expect(prompt.text).toContain(field);
    }
    // The old ticket-only wording that produced the inconclusive verdicts is gone.
    expect(prompt.text).not.toMatch(/^Review the candidate against the Ticket/);
  });

  it('assembles into a critic prompt carrying the Epic spec plus the engine guard and contract', async () => {
    const lib = new PromptLibrary(null);
    const resolved = (await lib.get('criticEpic')).resolved;
    const rendered = renderAgentPrompt(resolved, {
      ref: 'milestone-56',
      title: 'Router API coverage',
      description: 'Expose every router feature over /api/v1.',
      url: 'https://tracker.example/milestone/56',
      branch: 'epic/milestone-56',
    });
    const full = buildWorkflowCriticPrompt(rendered, bundledEnginePrompts());
    expect(full).toContain('milestone-56');
    expect(full).toContain('Router API coverage');
    expect(full).toContain('Expose every router feature over /api/v1.');
    expect(full).toMatch(/READ-ONLY/i);
    expect(full).toMatch(/verdict/i);
    expect(full).not.toMatch(/\{(ref|title|description|url|branch)\}/);
  });
});

describe('Epic fix prompt from the Prompt Library', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-epic-fix-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('uses a duplicate of a bundled entry named <code>-edited', async () => {
    const library = new PromptLibrary(join(root, 'duplicated'));
    await library.duplicate('epicResolveSuffix', 'epicResolveSuffix-edited');
    await library.update('epicResolveSuffix-edited', 'mine', 'MY SUFFIX for {branch}.');
    expect((await epicFixTexts(library)).resolveSuffix).toBe('MY SUFFIX for {branch}.');
  });

  it('leaves an unedited install on the bundled entries', async () => {
    const library = new PromptLibrary(join(root, 'unedited'));
    expect(await convertEditedEpicFixPrompts(library, baselineConfig(), NO_RETIRED)).toEqual([]);
    const config = baselineConfig();
    const texts = await epicFixTexts(library);
    expect(texts.resolvePrompt).toBe(config.verify.epic.resolvePrompt);
    expect(texts.resolveSuffix).toBe(config.verify.epic.resolveSuffix);
  });

  it('converts edited settings exactly once across two boots and keeps the edited text', async () => {
    const library = new PromptLibrary(join(root, 'edited'));
    const config = baselineConfig();
    config.verify.epic.resolveSuffix = 'EDITED SUFFIX for {branch}.';
    const retired = { global: { epicFailingVerification: 'EDITED FAILURE: {reason}' }, workspaces: {} };

    expect(await convertEditedEpicFixPrompts(library, config, retired)).toEqual(['epicResolveSuffix', 'epicFailingVerification']);
    expect(await convertEditedEpicFixPrompts(new PromptLibrary(join(root, 'edited')), config, retired)).toEqual([]);

    const codes = (await library.list()).filter((e) => !e.bundled).map((e) => e.code).sort();
    expect(codes).toEqual(['epicFailingVerification-edited', 'epicResolveSuffix-edited']);
    const texts = await epicFixTexts(library);
    expect(texts.failingVerification).toBe('EDITED FAILURE: {reason}');
    expect(texts.resolveSuffix).toBe('EDITED SUFFIX for {branch}.');
  });
});

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

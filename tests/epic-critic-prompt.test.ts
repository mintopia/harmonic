import { describe, expect, it } from 'vitest';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { PromptLibrary } from '../src/domain/prompt-library-store.js';
import { templateEntries } from '../src/domain/workflow-library-store.js';
import { parseWorkflow, type WorkflowStepDefinition } from '../src/domain/workflow.js';
import { buildWorkflowCriticPrompt, renderAgentPrompt } from '../src/execution/prompt-assembly.js';

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

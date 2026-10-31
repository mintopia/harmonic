import { describe, expect, it } from 'vitest';
import { WorkflowLibrary } from '../src/domain/workflow-library-store.js';
import { validateWorkflowText } from '../web/src/workflow-editor-model.js';
import { addBlock, issuesByBlock, moveBlock, readBuilder, removeBlock, setAttemptsMax, setStepField } from '../web/src/workflow-builder-model.js';

const bundled = new WorkflowLibrary(null).list();

const SAMPLE = `# top comment
name: w
description: d
steps:
  - id: rebase
    uses: rebase
  - attempts:
      max: 2
      steps:
        - id: implement
          uses: agent
          with: { prompt: implement }
        # keep: flaky on CI, see #812
        - id: verify
          uses: command
          with: { command: npm test }
        - parallel_placeholder: nope
`.replace('        - parallel_placeholder: nope\n', `        - id: reviews
          parallel:
            - id: correctness
              uses: critic
              with: { prompt: p, harness: claude, model: m }
            - id: security
              if: \${{ contains(ticket.labels, 'security') }}
              uses: critic
              with: { prompt: p, harness: claude, model: m }
`);

describe('workflow builder model', () => {
  it.each(bundled.map((b) => [b.name, b.text]))('reads the bundled %s workflow and leaves its YAML untouched', (_name, text) => {
    const tree = readBuilder(text!);
    expect(tree).not.toBeNull();
    expect(tree!.steps.length).toBeGreaterThan(0);
    const leaf = tree!.steps.find((s) => s.kind === 'step')!;
    expect(setStepField(text!, leaf.path, 'id', (leaf as { id: string }).id)).toBe(text);
    expect(moveBlock(text!, ['steps', 0], ['steps'], 0)).toBe(text);
    expect(removeBlock(addBlock(text!, ['steps'], 0, { kind: 'run', hint: '' }), ['steps', 0])).toBe(text);
  });

  it('exposes steps, attempts, parallel groups and conditions', () => {
    const tree = readBuilder(SAMPLE)!;
    const attempts = tree.steps[1]!;
    expect(attempts).toMatchObject({ kind: 'attempts', max: '2' });
    const group = (attempts as { children: unknown[] }).children[2] as { kind: string; children: { id: string; condition?: string }[] };
    expect(group.kind).toBe('parallel');
    expect(group.children.map((c) => c.id)).toEqual(['correctness', 'security']);
    expect(group.children[1]!.condition).toBe("contains(ticket.labels, 'security')");
  });

  it('adds a step after implement without touching comments or flow style elsewhere', () => {
    const next = addBlock(SAMPLE, ['steps', 1, 'attempts', 'steps'], 1, { kind: 'run', hint: '' });
    expect(next).toContain('# top comment');
    expect(next).toContain('# keep: flaky on CI, see #812');
    expect(next).toContain('with: { prompt: implement }');
    expect(next).toContain('- id: run\n');
    expect(validateWorkflowText(next).issues).toEqual([]);
  });

  it('dragging a step into a parallel group puts it in the group', () => {
    const next = moveBlock(SAMPLE, ['steps', 1, 'attempts', 'steps', 1], ['steps', 1, 'attempts', 'steps', 2, 'parallel'], 0);
    expect(next).not.toBe(SAMPLE);
    const tree = readBuilder(next)!;
    const attempts = tree.steps[1] as { children: { kind: string; children?: { id: string }[] }[] };
    expect(attempts.children.map((c) => c.kind)).toEqual(['step', 'parallel']);
    expect(attempts.children[1]!.children!.map((c) => c.id)).toEqual(['verify', 'correctness', 'security']);
  });

  it('edits fields in place', () => {
    const next = setStepField(SAMPLE, ['steps', 1, 'attempts', 'steps', 0], 'harness', 'codex');
    expect(next).toContain('with: { prompt: implement, harness: codex }');
    const cond = setStepField(SAMPLE, ['steps', 1, 'attempts', 'steps', 1], 'condition', 'vars.review');
    expect(cond).toContain('if: ${{ vars.review }}');
    expect(setAttemptsMax(SAMPLE, ['steps', 1], '5')).toContain('max: 5');
  });

  it('option and harness/model are mutually exclusive', () => {
    const path = ['steps', 1, 'attempts', 'steps', 0];
    const step = (text: string) => (readBuilder(text)!.steps[1] as { children: { option?: string; harness?: string; model?: string }[] }).children[0]!;
    const picked = setStepField(setStepField(SAMPLE, path, 'harness', 'codex'), path, 'option', 'fast');
    expect([step(picked).option, step(picked).harness, step(picked).model]).toEqual(['fast', undefined, undefined]);
    const back = setStepField(picked, path, 'model', 'haiku');
    expect([step(back).option, step(back).model]).toEqual([undefined, 'haiku']);
    expect(step(setStepField(picked, path, 'option', '')).option).toBeUndefined();
  });

  it('an invariant-breaking change yields a validation issue on the block', () => {
    const next = setAttemptsMax(SAMPLE, ['steps', 1], '');
    const { issues } = validateWorkflowText(next);
    expect(issues.length).toBeGreaterThan(0);
    const byBlock = issuesByBlock(readBuilder(next)!, issues);
    expect([...byBlock.keys()]).toContain('steps/1');
  });
});

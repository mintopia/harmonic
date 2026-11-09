import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkflowLibrary } from '../src/domain/workflow-library-store.js';
import { parseWorkflow } from '../src/domain/workflow.js';
import { buildWorkflowDiagram } from '../src/domain/workflow-diagram.js';
import { computeLayout } from '../web/src/workflow-diagram-layout.js';

const bundledWorkflows = new WorkflowLibrary(null).list();
const bundled = (name: string): string => bundledWorkflows.find((w) => w.name === name)!.text;

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'settings-workflow-migration');
const layoutSources = [
  ...bundledWorkflows.map((w) => ({ name: `bundled ${w.name}`, text: w.text })),
  ...readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ({ name: `fixture ${f}`, text: readFileSync(join(FIXTURE_DIR, f), 'utf8') })),
];

const edgeKeys = (text: string) => buildWorkflowDiagram(parseWorkflow(text)).edges.map((e) => `${e.from}>${e.to}:${e.kind}:${e.label ?? ''}`);

const IMPLEMENT = `name: implement
description: d
steps:
  - id: rebase
    uses: rebase
  - attempts:
      max: 2
      steps:
        - id: build
          uses: agent
        - id: verify
          uses: verify
        - id: review
          uses: critic
          with:
            harness: claude
            model: claude-sonnet-5-5
            prompt: Review it.
  - id: merge
    uses: merge
`;

const PARALLEL = `name: sec
description: d
steps:
  - id: rebase
    uses: rebase
  - attempts:
      max: 3
      steps:
        - id: verify
          uses: command
          with: { command: npm test }
        - id: checks
          parallel:
            - id: correctness
              uses: critic
              with: { harness: claude, model: opus-5-5, prompt: critic-correctness }
            - id: security
              if: \${{ contains(ticket.labels, 'security') }}
              uses: critic
              with: { harness: codex, model: gpt-5-codex, prompt: critic-security }
  - id: merge
    uses: merge
`;

const CLEANUP = `${IMPLEMENT}cleanup:
  - id: tidy
    uses: cleanup
`;

describe('buildWorkflowDiagram', () => {
  it('draws the bundled implement workflow', () => {
    const m = buildWorkflowDiagram(parseWorkflow(bundled('implement')));
    expect(m.nodes.map((n) => `${n.id}:${n.kind}:${n.parent ?? ''}`)).toEqual([
      'attempts:attempts:',
      'rebase:step:',
      'build:step:attempts',
      'verify:step:attempts',
      'review:parallel:attempts',
      'critic:step:review',
      'merge:step:',
      'post-merge-check:step:',
      'close-ticket:step:',
      'escalation:escalation:',
      'cleanup:cleanup:',
    ]);
    expect(m.nodes.find((n) => n.id === 'review')?.condition).toBe('${{ vars.review }}');
    expect(edgeKeys(bundled('implement'))).toEqual([
      'rebase>build:outcome:pass',
      'build>verify:outcome:pass',
      'verify>review:outcome:pass',
      'review>merge:outcome:pass',
      'merge>post-merge-check:outcome:pass',
      'post-merge-check>close-ticket:outcome:pass',
      'review>build:back:fail · inconclusive',
      'attempts>escalation:escalation:max reached',
      'merge>escalation:escalation:conflict',
      'post-merge-check>escalation:escalation:fail',
      'close-ticket>cleanup:done:done',
    ]);
  });

  it('draws the bundled research workflow', () => {
    const m = buildWorkflowDiagram(parseWorkflow(bundled('research')));
    expect(m.nodes.map((n) => `${n.id}:${n.kind}:${n.parent ?? ''}`)).toEqual([
      'attempts:attempts:',
      'research:step:attempts',
      'artifact:step:',
      'escalation:escalation:',
    ]);
    expect(edgeKeys(bundled('research'))).toEqual([
      'research>artifact:outcome:pass',
      'research>research:back:fail · inconclusive',
      'attempts>escalation:escalation:max reached',
    ]);
  });

  it.each(layoutSources.map((s) => [s.name, s.text] as const))('lays out every node and edge of %s', (_name, text) => {
    const model = buildWorkflowDiagram(parseWorkflow(text));
    const layout = computeLayout(model);
    expect(layout.nodes.map((n) => n.node.id).sort()).toEqual(model.nodes.map((n) => n.id).sort());
    expect(layout.edges).toHaveLength(model.edges.length);
    for (const e of layout.edges) expect(e.points.length, `${e.edge.from}>${e.edge.to}`).toBeGreaterThanOrEqual(2);
  });

  it('groups parallel steps and keeps if conditions', () => {
    const m = buildWorkflowDiagram(parseWorkflow(PARALLEL));
    const group = m.nodes.find((n) => n.id === 'checks');
    expect(group?.kind).toBe('parallel');
    expect(group?.parent).toBe('attempts');
    const security = m.nodes.find((n) => n.id === 'security');
    expect(security).toMatchObject({ parent: 'checks', condition: "${{ contains(ticket.labels, 'security') }}", detail: 'critic · codex gpt-5-codex\nprompt critic-security' });
    expect(m.nodes.find((n) => n.id === 'verify')?.detail).toBe('command · npm test');
    const edges = edgeKeys(PARALLEL);
    expect(edges).toContain('verify>checks:outcome:pass');
    expect(edges).toContain('checks>merge:outcome:pass');
    expect(edges).toContain('checks>verify:back:fail · inconclusive');
  });

  it('adds the cleanup box after the last step', () => {
    const m = buildWorkflowDiagram(parseWorkflow(CLEANUP));
    expect(m.nodes.find((n) => n.id === 'cleanup')).toMatchObject({ kind: 'cleanup', detail: 'uses: cleanup' });
    expect(edgeKeys(CLEANUP)).toContain('merge>cleanup:done:done');
    expect(edgeKeys(IMPLEMENT).some((e) => e.includes('cleanup'))).toBe(false);
  });

  it('places Escalation beside merge and routes escalation edges as in the mockup', () => {
    const wf = `${PARALLEL}`;
    const layout = computeLayout(buildWorkflowDiagram(parseWorkflow(wf)));
    const at = (id: string) => layout.nodes.find((n) => n.node.id === id)!;
    const esc = at('escalation');
    expect(esc.y).toBe(at('merge').y);
    expect(esc.x).toBeGreaterThan(at('merge').x + at('merge').width);
    const attempts = at('attempts');
    const maxReached = layout.edges.find((e) => e.edge.label === 'max reached')!;
    expect(maxReached.points[0]!.x).toBeCloseTo(attempts.x + attempts.width);
    expect(maxReached.points.at(-1)!.y).toBe(esc.y);
    const conflict = layout.edges.find((e) => e.edge.label === 'conflict')!;
    expect(new Set(conflict.points.map((p) => p.y)).size).toBe(1);
    const nested = at('security');
    expect(nested.inParallel).toBe(true);
    expect(nested.y).toBeGreaterThan(at('checks').y);
  });

  it('keeps edge labels off the node boxes', () => {
    const layout = computeLayout(buildWorkflowDiagram(parseWorkflow(PARALLEL)));
    for (const { label } of layout.edges) {
      if (!label) continue;
      const w = label.text.length * 6.2;
      const x0 = label.anchor === 'start' ? label.x : label.anchor === 'end' ? label.x - w : label.x - w / 2;
      for (const n of layout.nodes) {
        if (n.node.kind === 'attempts' || n.node.kind === 'parallel') continue;
        const overlaps = x0 < n.x + n.width && x0 + w > n.x && label.y - 10 < n.y + n.height && label.y > n.y;
        expect(overlaps, `${label.text} over ${n.node.id}`).toBe(false);
      }
    }
  });

  it('keeps edge labels off group borders', () => {
    const layout = computeLayout(buildWorkflowDiagram(parseWorkflow(PARALLEL)));
    const groups = layout.nodes.filter((n) => n.node.kind === 'attempts' || n.node.kind === 'parallel');
    for (const { label } of layout.edges) {
      if (!label) continue;
      for (const g of groups) {
        for (const border of [g.y, g.y + g.height]) expect(border > label.y - 10 && border < label.y).toBe(false);
      }
    }
  });

  it('clips long critic prompts so they stay inside the node', () => {
    const wf = PARALLEL.replace('prompt: critic-correctness', 'prompt: Review the candidate against the Ticket and judge it');
    const details = buildWorkflowDiagram(parseWorkflow(wf)).nodes.map((n) => n.detail ?? '');
    const prompt = details.flatMap((d) => d.split('\n')).find((l) => l.startsWith('prompt Review'))!;
    expect(prompt.length).toBeLessThanOrEqual(34);
    expect(prompt.endsWith('…')).toBe(true);
  });
});

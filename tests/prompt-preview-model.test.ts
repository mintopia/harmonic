import { describe, expect, it } from 'vitest';
import {
  CRITIC_NO_ISSUE_PLACEHOLDERS,
  SAMPLE_DRIVE_FIELDS,
  compileCriticPreview,
  compileEpicCriticPreview,
  TEMPLATE_PLACEHOLDERS,
  assemblePreview,
  defaultConditions,
  fragmentPlaceholders,
  parseMarked,
  promptSettingsView,
} from '../web/src/prompt-preview-model.js';
import { baselineConfig } from '../src/config.js';
import { PROMPT_ANATOMIES } from '../src/domain/prompt-anatomy.js';
import { PROMPT_TEMPLATE_IDS } from '../src/domain/prompt-templates.js';

const DEFAULT_PROMPT_FRAGMENTS = baselineConfig().promptFragments;

describe('prompt-preview-model (settings compiled preview)', () => {
  it('offers the core Task-identity tokens plus {skill} for a native Task critic (no ticket ref/url)', () => {
    expect(CRITIC_NO_ISSUE_PLACEHOLDERS.map((p) => p.token)).toEqual(['{taskId}', '{title}', '{description}', '{skill}']);
    expect(CRITIC_NO_ISSUE_PLACEHOLDERS.filter((p) => p.core).map((p) => p.token)).toEqual([
      '{taskId}',
      '{title}',
      '{description}',
    ]);
  });

  it('compileCriticPreview shows both Task-kind variants, each with the read-only + verdict scaffolding', () => {
    const [mirrored, native] = compileCriticPreview({
      issuePrompt: 'Review issue {ref}: {title}.',
      noIssuePrompt: 'Review task {taskId} — {title} via {skill}.',
    }, DEFAULT_PROMPT_FRAGMENTS);
    if (!mirrored || !native) throw new Error('expected two compiled variants');

    expect(mirrored.label).toMatch(/mirrored/i);
    expect(mirrored.text).toContain(`Review issue ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title}.`);
    expect(mirrored.text).toContain('the referenced ticket');

    expect(native.label).toMatch(/native/i);
    // The Task-identity tokens resolve even with no ticket — the feature gap this closed.
    expect(native.text).toContain(
      `Review task ${SAMPLE_DRIVE_FIELDS.taskId} — ${SAMPLE_DRIVE_FIELDS.title} via ${SAMPLE_DRIVE_FIELDS.skill}.`,
    );
    expect(native.text).toContain('there is no external ticket to consult');

    for (const { text } of [mirrored, native]) {
      expect(text).toMatch(/READ-ONLY/i);
      expect(text).toContain('"verdict":"pass|fail|inconclusive"');
      expect(text).not.toContain('HARMONIC_UNTRUSTED_DIFF');
    }
  });

  it('offers the Epic resolver prompt its supported tokens', () => {
    expect(TEMPLATE_PLACEHOLDERS.epicResolvePrompt.map((p) => p.token)).toEqual(['{title}', '{description}', '{ref}', '{url}']);
  });

  it('compiles an Epic critic against its ticket context', () => {
    const out = compileEpicCriticPreview('Review Epic {ref}: {title}.', DEFAULT_PROMPT_FRAGMENTS);

    expect(out).toContain(`Review Epic ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title}.`);
    expect(out).toContain('the referenced ticket');
    expect(out).toMatch(/READ-ONLY/i);
  });

  describe('parseMarked', () => {
    const open = (key: string) => `\uE000${key}\uE001`;
    const close = '\uE002';

    it('splits marked parts, nests them, and labels unmarked text as built in', () => {
      const text = `${open('fragment:peerMessages')}head ${open('fragment:peerMessage')}one${close} tail${close}\n\nglue\n\n${open('template:pauseMessage')}pause${close}`;
      expect(parseMarked(text)).toEqual([
        {
          key: 'fragment:peerMessages',
          children: ['head ', { key: 'fragment:peerMessage', children: ['one'] }, ' tail'],
        },
        { key: null, children: ['glue'] },
        { key: 'template:pauseMessage', children: ['pause'] },
      ]);
    });

    it('drops whitespace-only gaps and rejects unknown markers', () => {
      expect(parseMarked(`${open('template:pauseMessage')}a${close}\n\n  \n${open('template:commitNudge')}b${close}`).map((s) => s.key)).toEqual([
        'template:pauseMessage',
        'template:commitNudge',
      ]);
      expect(() => parseMarked(`${open('template:nope')}a${close}`)).toThrow(/Unknown prompt part/);
    });
  });

  describe('assemblePreview', () => {
    it('compiles the default Implementation turn with the configured Task prompt filled', () => {
      const config = baselineConfig();
      config.taskPrompt = 'DO: {prompt}';
      const view = promptSettingsView({ config });
      const [anatomy] = PROMPT_ANATOMIES;
      if (!anatomy) throw new Error('no anatomy');
      const segments = assemblePreview(anatomy.id, view, defaultConditions(anatomy));
      expect(segments[0]).toEqual({ key: 'template:taskPrompt', children: ['DO: Example task prompt.'] });
      expect(segments.map((s) => s.key)).toContain('fragment:peerLine');
    });

    it('falls back to a placeholder when no critic is configured', () => {
      const view = promptSettingsView({ config: baselineConfig() });
      const critic = PROMPT_ANATOMIES.find((a) => a.id === 'criticReview');
      if (!critic) throw new Error('no critic anatomy');
      const segments = assemblePreview('criticReview', view, defaultConditions(critic));
      expect(segments[0]).toEqual({ key: 'criticPrompt', children: ["(each critic's own prompt)"] });
    });
  });

  describe('critic preview', () => {
    const critic = PROMPT_ANATOMIES.find((a) => a.id === 'criticReview');
    if (!critic) throw new Error('no critic anatomy');
    const keys = (segments: ReturnType<typeof assemblePreview>) => JSON.stringify(segments);

    it('reviews a dirty worktree on an identical base as a diff with the working-tree note, as the runtime does', () => {
      const view = promptSettingsView({ config: baselineConfig() });
      const dirty = assemblePreview('criticReview', view, { flags: { dirtyWorktree: true }, choices: { revision: 'identical', ticket: 'ticket' } });
      expect(keys(dirty)).toContain('fragment:criticRevisionDiff');
      expect(keys(dirty)).toContain('fragment:criticWorkingTreeNote');
      expect(keys(dirty)).not.toContain('fragment:criticRevisionIdentical');
      const clean = assemblePreview('criticReview', view, { flags: { dirtyWorktree: false }, choices: { revision: 'identical', ticket: 'ticket' } });
      expect(keys(clean)).toContain('fragment:criticRevisionIdentical');
      expect(keys(clean)).not.toContain('fragment:criticWorkingTreeNote');
    });

    it('labels the critic segment with the name of the critic whose prompt it shows', () => {
      const config = baselineConfig();
      config.verify.task.preMerge.critics = [
        { id: 'c1', name: 'Security reviewer', issuePrompt: 'Look for holes.', noIssuePrompt: 'Look for holes.', model: 'm', harness: 'claude', timeoutSeconds: 300 },
      ];
      const [segment] = assemblePreview('criticReview', promptSettingsView({ config }), defaultConditions(critic));
      expect(segment).toMatchObject({ key: 'criticPrompt', label: 'Critic prompt · Security reviewer' });
    });
  });

  describe('previous Attempt feedback', () => {
    const implementation = PROMPT_ANATOMIES.find((a) => a.id === 'implementation');
    if (!implementation) throw new Error('no implementation anatomy');
    const builtIn = (flags: Record<string, boolean>, origin: string) =>
      assemblePreview('implementation', promptSettingsView({ config: baselineConfig() }), { flags, choices: { origin } })
        .filter((s) => s.key === null)
        .map((s) => s.children.join(''))
        .join('\n');

    it.each(['native', 'mirrored'])('shows the built-in feedback section for a %s Task only when the flag is on', (origin) => {
      expect(implementation.flags.some((f) => f.id === 'feedback')).toBe(true);
      expect(builtIn({ feedback: true }, origin)).toContain('## Feedback from the previous attempt');
      expect(builtIn({ feedback: false }, origin)).not.toContain('## Feedback from the previous attempt');
    });
  });

  it('offers placeholders for every template and fragment', () => {
    for (const id of PROMPT_TEMPLATE_IDS) expect(TEMPLATE_PLACEHOLDERS[id], id).toBeDefined();
    expect(fragmentPlaceholders('selfHeal').filter((p) => p.core).map((p) => p.token)).toEqual(['{reason}', '{output}']);
  });
});

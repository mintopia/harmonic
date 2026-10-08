import { describe, expect, it } from 'vitest';
import {
  CRITIC_NO_ISSUE_PLACEHOLDERS,
  EPIC_RESOLVE_PLACEHOLDERS,
  SAMPLE_DRIVE_FIELDS,
  SAMPLE_TASK_ID,
  compileCriticPreview,
  compileDrivePreview,
  compileEpicCriticPreview,
  compileEpicRefreshPreview,
  compileCriticFragmentPreview,
  compileEpicResolvePreview,
  compileTaskIdPreview,
  compileTaskPreview,
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

  it('compileDrivePreview fills the Drive tokens with sample values', () => {
    const out = compileDrivePreview('task {taskId}: issue {ref} — {title} ({url}) via {skill}: {description}', baselineConfig());
    expect(out).toBe(
      `task ${SAMPLE_DRIVE_FIELDS.taskId}: issue ${SAMPLE_DRIVE_FIELDS.ref} — ${SAMPLE_DRIVE_FIELDS.title} (${SAMPLE_DRIVE_FIELDS.url}) via ${SAMPLE_DRIVE_FIELDS.skill}: ${SAMPLE_DRIVE_FIELDS.description}`,
    );
    expect(out).not.toMatch(/\{(taskId|skill|ref|url|title|description)\}/);
  });

  it('compileTaskIdPreview fills {taskId}', () => {
    expect(compileTaskIdPreview('Task {taskId} running unattended', baselineConfig())).toBe(`Task ${SAMPLE_TASK_ID} running unattended`);
  });

  it('compileTaskPreview fills the task-prompt tokens', () => {
    const config = baselineConfig();
    const out = compileTaskPreview('{prompt} [{id}/{harness}/{model}] in {workingDir}', config);
    expect(out).toBe(
      `Example task prompt. [123/${config.defaults.harness}/${config.harnesses[config.defaults.harness].defaultModel}] in /repo`,
    );
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

  it('compiles an Epic critic against its ticket context', () => {
    const out = compileEpicCriticPreview('Review Epic {ref}: {title}.', DEFAULT_PROMPT_FRAGMENTS);

    expect(out).toContain(`Review Epic ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title}.`);
    expect(out).toContain('the referenced ticket');
    expect(out).toMatch(/READ-ONLY/i);
  });

  it('matches the Epic resolver prompt and offers its supported tokens', () => {
    expect(EPIC_RESOLVE_PLACEHOLDERS.map((p) => p.token)).toEqual(['{title}', '{description}', '{ref}', '{url}']);
    expect(compileEpicResolvePreview('Fix {ref}: {title} — {description}', 'Work in {branch}.', DEFAULT_PROMPT_FRAGMENTS)).toContain(
      `Fix ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title} — ${SAMPLE_DRIVE_FIELDS.description}`,
    );
    expect(compileEpicResolvePreview('Fix {ref}.', 'Work in {branch}.', DEFAULT_PROMPT_FRAGMENTS)).toContain('## Failing Epic verification');
    expect(compileEpicResolvePreview('Fix {ref}.', 'Stay on {branch}.', DEFAULT_PROMPT_FRAGMENTS)).toContain(`Stay on epic/${SAMPLE_DRIVE_FIELDS.ref}.`);
    expect(compileEpicResolvePreview('Fix.', '{fragment.readOnlyRestraint} on {branch}', { ...DEFAULT_PROMPT_FRAGMENTS, readOnlyRestraint: 'LOOK ONLY', epicFailingVerification: 'FAILED: {reason}' })).toBe(
      `Fix.\n\nFAILED: Example verifier feedback.\n\nLOOK ONLY on epic/${SAMPLE_DRIVE_FIELDS.ref}`,
    );
  });

  it('previews the Epic refresh prompt with fragments expanded and the Epic branch as the checkout', () => {
    const out = compileEpicRefreshPreview('Merging {defaultBranch} into {branch}: {detail}\n{fragment.conflictResolution}', {
      promptFragments: { ...DEFAULT_PROMPT_FRAGMENTS, conflictResolution: 'in {baseDir}: keep {baseBranch} and {taskBranch}' },
    });
    expect(out).toBe('Merging develop into epic/example: Both branches changed src/app.ts.\nin /repo: keep epic/example and develop');
  });

  it('previews a critic fragment inside the whole critic prompt, including the uncommitted-changes variant', () => {
    const fragments = { ...DEFAULT_PROMPT_FRAGMENTS, criticWorkingTreeNote: 'DIRTY against {base}' };
    expect(compileCriticFragmentPreview(fragments, 'dirty')).toContain('DIRTY against ba5e');
    expect(compileCriticFragmentPreview(fragments, 'diff')).not.toContain('DIRTY against');
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

  it('offers placeholders for every template and fragment', () => {
    for (const id of PROMPT_TEMPLATE_IDS) expect(TEMPLATE_PLACEHOLDERS[id], id).toBeDefined();
    expect(fragmentPlaceholders('selfHeal').filter((p) => p.core).map((p) => p.token)).toEqual(['{reason}', '{output}']);
  });
});

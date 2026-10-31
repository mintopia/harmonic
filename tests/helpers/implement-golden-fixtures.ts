import { loadBaselineConfig } from '../../src/config.js';
import { resolveCommitNudge, resolveDrive, resolvePromptFragments, resolveTaskPrompt } from '../../src/domain/setting-override.js';
import { composeAttemptPrompt, composeDriveOpening, type AttemptPromptInput } from '../../src/execution/prompt-assembly.js';
import { driveFields, promptForTask } from '../../src/execution/prompt-template.js';

export const NATIVE_TASK = {
  id: 42,
  harness: 'claude',
  model: 'sonnet',
  wayfinderType: null,
  trackerRef: null,
  mapRef: null,
  workingDir: '/work/task-42',
  prompt: 'Add a --verbose flag\n\nKeep {taskId} and ${{ prompts.selfHeal }} literal.',
};

export const TICKET_TASK = {
  id: 43,
  harness: 'claude',
  model: 'sonnet',
  origin: 'mirrored',
  wayfinderType: null,
  trackerRef: 123,
  mapRef: null,
  workingDir: '/work/task-43',
  prompt: 'Fix the timeout\n\nThe request hangs forever.',
};

export const TICKET_URL = 'https://github.com/o/r/issues/123';
export const FEEDBACK = 'Tests were missing.';
export const HEAL = { attempt: 1, reason: 'R', output: 'O' };

export function buildOldImplementPrompts(heal: typeof HEAL = HEAL): Record<string, string> {
  const config = loadBaselineConfig();
  const fragments = resolvePromptFragments(undefined, config);
  const drive = resolveDrive(undefined, config);
  const taskPrompt = resolveTaskPrompt(undefined, config);
  const urlFor = () => TICKET_URL;
  const base = { seed: undefined, seedMode: 'append', freshSessionContext: null, heal: undefined, condensed: null, peerText: '', rebaseConflict: false, codeIndexRepoId: null } as const;
  const compose = (opening: string, extra: Partial<AttemptPromptInput> = {}) => composeAttemptPrompt({ ...base, opening, ...extra }, fragments);
  const native = (feedback?: string) => promptForTask({ ...NATIVE_TASK, feedback }, taskPrompt);
  const ticket = (task: typeof TICKET_TASK, feedback?: string) =>
    composeDriveOpening(drive, driveFields(task as never, urlFor), feedback);
  return {
    nativeFirst: compose(native()),
    nativeFeedback: compose(native(FEEDBACK)),
    ticketFirst: compose(ticket(TICKET_TASK)),
    ticketFeedback: compose(ticket(TICKET_TASK, FEEDBACK)),
    ticketCodex: compose(ticket({ ...TICKET_TASK, harness: 'codex' })),
    nativeHeal: compose(native(), { heal }),
    ticketHeal: compose(ticket(TICKET_TASK), { heal }),
    commitNudge: resolveCommitNudge(undefined, config),
  };
}

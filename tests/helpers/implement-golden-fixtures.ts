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

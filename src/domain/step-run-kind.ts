export type StepRunKind = 'rebase' | 'agent' | 'check' | 'marker' | 'critic' | 'publish' | 'tracker' | 'cleanup';

const KINDS: Record<string, StepRunKind> = {
  rebase: 'rebase',
  agent: 'agent',
  run: 'check',
  command: 'check',
  'post-merge-check': 'check',
  verify: 'marker',
  critic: 'critic',
  merge: 'publish',
  'open-pr': 'publish',
  artifact: 'publish',
  'close-ticket': 'tracker',
  comment: 'tracker',
  cleanup: 'cleanup',
};

export function stepRunKind(action: string): StepRunKind {
  return KINDS[action] ?? 'check';
}

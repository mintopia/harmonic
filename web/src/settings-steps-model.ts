import type { SettingTab } from '../../src/domain/settings-registry.js';

export interface StepDef {
  id: string;
  title: string;
  summary: string;
}

export const TAB_STEPS: Record<SettingTab, readonly StepDef[]> = {
  general: [
    { id: 'identity', title: 'Identity', summary: 'Name this instance' },
    { id: 'access', title: 'Access', summary: 'Password and permissions' },
    { id: 'chats', title: 'Chats', summary: 'Conversation defaults' },
    { id: 'files', title: 'Files', summary: 'Folders to leave out' },
  ],
  execution: [
    { id: 'workflow', title: 'Workflow', summary: 'Which process runs' },
    { id: 'agent', title: 'Agent', summary: 'Harness and model' },
    { id: 'where', title: 'Where', summary: 'Execution Target' },
    { id: 'limits', title: 'Limits', summary: 'Bounds and automation' },
  ],
  prompts: [
    { id: 'find', title: 'Find', summary: 'Browse the library' },
    { id: 'edit', title: 'Edit', summary: 'Change a prompt' },
    { id: 'impact', title: 'Check impact', summary: 'See what it affects' },
  ],
  integrations: [
    { id: 'code', title: 'Code', summary: 'Repository' },
    { id: 'work', title: 'Work', summary: 'Tracker and labels' },
    { id: 'agents', title: 'Agents', summary: 'Harnesses' },
    { id: 'updates', title: 'Updates', summary: 'Notifications' },
  ],
  archive: [
    { id: 'keep', title: 'Keep', summary: 'How long Archives last' },
    { id: 'export', title: 'Export', summary: 'What leaves the machine' },
    { id: 'redact', title: 'Redact', summary: 'Patterns to hide' },
    { id: 'deliver', title: 'Deliver', summary: 'Where Exports go' },
  ],
};

export const TAB_RAIL_TITLES: Record<SettingTab, string> = {
  general: 'This instance',
  execution: 'How a Ticket runs',
  prompts: 'Changing what agents are told',
  integrations: 'Connecting Harmonic',
  archive: 'After a Task ends',
};

export function visibleSteps(tab: SettingTab, stepsWithContent: ReadonlySet<string>): StepDef[] {
  return TAB_STEPS[tab].filter((step) => stepsWithContent.has(step.id));
}

export function resolveStep(steps: readonly StepDef[], requested: string | null): string {
  if (requested && steps.some((step) => step.id === requested)) return requested;
  return steps[0]?.id ?? '';
}

export function neighbourStep(steps: readonly StepDef[], current: string, direction: -1 | 1): string | null {
  const index = steps.findIndex((step) => step.id === current);
  if (index < 0) return null;
  return steps[index + direction]?.id ?? null;
}

export interface SettingsLocation {
  tab: SettingTab | null;
  step: string | null;
}

export function parseSettingsLocation(search: string, tabs: readonly SettingTab[]): SettingsLocation {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  return {
    tab: tab && (tabs as readonly string[]).includes(tab) ? (tab as SettingTab) : null,
    step: params.get('step'),
  };
}

export function formatSettingsLocation(search: string, tab: SettingTab, step: string): string {
  const params = new URLSearchParams(search);
  params.set('tab', tab);
  if (step) params.set('step', step);
  else params.delete('step');
  return `?${params.toString()}`;
}

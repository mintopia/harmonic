import type { SettingTab } from '../../src/domain/settings-registry.js';

export interface StepDef {
  id: string;
  title: string;
  summary: string;
  heading: string;
  intro: string;
  nextTitle?: string;
  note?: string;
}

const INSTANCE_INTRO = 'What this Harmonic is called, who can reach it, and what it ignores.';
const ARCHIVE_HEADING = 'What happens to a finished Task?';
const ARCHIVE_INTRO =
  'Every Task keeps a raw Archive. When it reaches done, closed or failed, Harmonic can bundle it, redact it and deliver it.';

export const TAB_STEPS: Record<SettingTab, readonly StepDef[]> = {
  general: [
    { id: 'identity', title: 'Identity', summary: 'Name this instance', heading: 'This instance', intro: INSTANCE_INTRO },
    { id: 'access', title: 'Access', summary: 'Password and permissions', heading: 'This instance', intro: INSTANCE_INTRO },
    { id: 'chats', title: 'Chats', summary: 'Conversation defaults', heading: 'This instance', intro: INSTANCE_INTRO },
    { id: 'files', title: 'Files', summary: 'Folders to leave out', heading: 'This instance', intro: INSTANCE_INTRO },
  ],
  execution: [
    {
      id: 'workflow',
      title: 'Workflow',
      summary: 'Which process runs',
      heading: 'Which workflow runs?',
      intro:
        'Resolved once when a Ticket starts working, and again on Retry. Harmonic walks these rules in order; the first one that matches picks the workflow.',
      note: 'Edits apply from each Ticket’s next Retry.',
    },
    {
      id: 'agent',
      title: 'Agent',
      summary: 'Harness and model',
      heading: 'Which agent and model?',
      intro:
        'Picks the Harness and model for the workflow’s agent steps. A step that names its own harness or model in YAML keeps it. First match wins.',
      nextTitle: 'Which agent',
    },
    {
      id: 'where',
      title: 'Where',
      summary: 'Execution Target',
      heading: 'Where does it run?',
      intro:
        'The workflow’s runs_on: names an Execution Target; steps without one run here on the host. Then choose how the checkout is isolated.',
      nextTitle: 'Where it runs',
    },
    {
      id: 'limits',
      title: 'Limits',
      summary: 'Bounds and automation',
      heading: 'Limits and automation',
      intro: 'What starts work without you, and the bounds that escalate a Ticket instead of letting it run on.',
    },
  ],
  prompts: [
    {
      id: 'find',
      title: 'Find',
      summary: 'Browse the library',
      heading: 'Which prompt do you want to change?',
      intro:
        'Workflow steps name a prompt by code. A prompt can include another with {{inc}}, so shared text lives in one place.',
      note: 'Edits apply to the next execution.',
    },
    { id: 'edit', title: 'Edit', summary: 'Change a prompt', heading: 'Edit the prompt', intro: 'Change the text agents are told.' },
    { id: 'impact', title: 'Check impact', summary: 'See what it affects', heading: 'Check impact', intro: 'See which workflows use this prompt.' },
  ],
  integrations: [
    {
      id: 'code',
      title: 'Code',
      summary: 'Repository',
      heading: 'Where does the code live?',
      intro: 'The forge that hosts branches, PRs and Merges. Detected from the origin remote unless you override it.',
    },
    {
      id: 'work',
      title: 'Work',
      summary: 'Tracker and labels',
      heading: 'Where does work come from?',
      intro: 'Harmonic mirrors a tracker’s issues onto the board as Tasks. It uses the first source it finds.',
    },
    {
      id: 'agents',
      title: 'Agents',
      summary: 'Harnesses',
      heading: 'Which agents can Harmonic drive?',
      intro: 'Harness CLIs driven over ACP. Which one runs a Ticket is chosen in Running Tickets › Agent.',
    },
    {
      id: 'updates',
      title: 'Updates',
      summary: 'Notifications',
      heading: 'Who hears about it?',
      intro:
        'Channels that receive Task and queue events. Adding or removing a channel applies at once; subscriptions save with the bar.',
    },
  ],
  archive: [
    { id: 'keep', title: 'Keep', summary: 'How long Archives last', heading: ARCHIVE_HEADING, intro: ARCHIVE_INTRO },
    { id: 'export', title: 'Export', summary: 'What leaves the machine', heading: ARCHIVE_HEADING, intro: ARCHIVE_INTRO },
    { id: 'redact', title: 'Redact', summary: 'Patterns to hide', heading: ARCHIVE_HEADING, intro: ARCHIVE_INTRO },
    { id: 'deliver', title: 'Deliver', summary: 'Where Exports go', heading: ARCHIVE_HEADING, intro: ARCHIVE_INTRO },
  ],
};

export const BREADCRUMB_INCLUDES_STEP: ReadonlySet<SettingTab> = new Set<SettingTab>(['execution', 'integrations']);

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

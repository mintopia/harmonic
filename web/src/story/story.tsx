import { useState } from 'react';
import { api, ApiError } from '../api';
import type { JSX } from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import { GlobalVerificationSettings } from '../components/VerificationSettings';
import { TicketPage } from '../components/TicketPage';
import { ChatTranscript } from '../components/ticket/ChatTranscript';
import { PromptSent } from '../components/ticket/Description';
import type { AttemptLogEvent, VerifierStatus } from '../types';
import { EpicPage } from '../components/EpicPage';
import { StatsPage } from '../components/StatsPage';
import { TimelinePage } from '../components/TimelinePage';
import { Composer } from '../components/conversation/Composer';
import { ConversationsPage } from '../components/ConversationLauncher';
import { config as storyConfig, workspaces as storyWorkspaces } from './fixtures';
import { Board } from '../components/Board';
import { ActivityView } from '../components/ActivityView';
import { FilesPage } from '../components/FilesPage';
import { CodeViewer } from '../components/CodeViewer';
import { GlobalDashboard } from '../components/GlobalDashboard';
import { ExtendGuardrailDialog } from '../components/ExtendGuardrailDialog';
import { CriticSessions, Verification } from '../components/ticket/Verification';
import { LifecycleTimeline } from '../components/ticket/LifecycleTimeline';
import { MergeProgress } from '../components/MergeProgress';
import { EpicIntegrationBar } from '../components/EpicIntegrationBar';
import type { MergeStepEvent } from '../merge-progress-model';
import { HintBanner } from '../components/HintBanner';
import { SettingsPage } from '../components/SettingsPage';
import { ExportPanel } from '../components/ticket/ExportPanel';
import type { RoutingLabelOverlayEntry, TaskExportStatus, Workspace } from '../types';
import { RoutingLabelOverlayEditor } from '../components/RoutingLabelOverlayEditor';
import { SecretField, IssueTrackerSection, CodeRepositorySection, TriageLabelsSection } from '../components/TrackerSettings';
import { SettingsSection } from '../components/SettingsSection';
import { criticLog, task, boardEpic, boardTasks, doneEpic, runs, timeline, verificationAttempts as storyVerificationAttempts, verifierStatuses } from './fixtures';

const mergedSteps: MergeStepEvent[] = [
  { step: 'started', baseBranch: 'develop', taskBranch: 'task/handoff-10-merge-visibility' },
  { step: 'conflict', paths: ['src/execution/merge-policy.ts', 'web/src/App.tsx'] },
  { step: 'resolve-turn', turn: 1, unmergedCount: 2 },
  { step: 'post-check-skipped', mergeOid: '4f7a1c9e2b3d5a6f8091' },
  { step: 'merged', mergeOid: '4f7a1c9e2b3d5a6f8091' },
  { step: 'checkout-synced', mergeOid: '4f7a1c9e2b3d5a6f8091', mergedPaths: ['src/App.tsx'], keptPaths: ['README.md'] },
];

const revertedSteps: MergeStepEvent[] = [
  { step: 'started', baseBranch: 'develop', taskBranch: 'task/schema-sync-rewrite' },
  { step: 'post-check-passed', mergeOid: 'aa11bb22cc33dd44ee55' },
  { step: 'reverted', mergeOid: '9c8d7e6f5a4b3c2d1e0f', revertOid: '112233445566778899aa' },
  { step: 'escalated', reason: 'post-merge-red', message: 'The post-merge check on develop failed after merging task/schema-sync-rewrite; the merge was reverted so the base stays green.\n\nFailing output:\n  FAIL tests/schema-sync.test.ts > drops a removed column' },
];

const reconciledSteps: MergeStepEvent[] = [
  { step: 'started', baseBranch: 'develop', taskBranch: 'task/reconcile-fixture' },
  { step: 'post-check-passed', mergeOid: '7a1b2c3d4e5f60718293' },
  { step: 'reconciled', fromBase: 'a1b2c3d4e5f6', toBase: 'b2c3d4e5f6a1', mergeOid: '7a1b2c3d4e5f60718293' },
  { step: 'checkout-synced', mergeOid: '7a1b2c3d4e5f60718293', mergedPaths: ['src/App.tsx'], keptPaths: [] },
  { step: 'merged', mergeOid: '7a1b2c3d4e5f60718293' },
];

const rebuildingSteps: MergeStepEvent[] = [
  { step: 'started', baseBranch: 'develop', taskBranch: 'task/rebuild-fixture' },
  { step: 'post-check-passed', mergeOid: '112233445566778899aa' },
  { step: 'rebuilding', fromBase: 'a1b2c3d4e5f6', toBase: 'c3d4e5f6a1b2', paths: ['src/execution/merge-policy.ts'] },
  { step: 'post-check-passed', mergeOid: '99aabbccddee00112233' },
  { step: 'merged', mergeOid: '99aabbccddee00112233' },
];

const params = new URLSearchParams(window.location.search);
const which = params.get('story');
const theme = params.get('theme') === 'light' ? 'light' : 'dark';

function StoryFrame({ style, children }: { style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--hm-canvas)', ...style }}>
      {children}
    </div>
  );
}

function SettingsStory() {
  const seed = structuredClone(storyConfig);
  seed.verify.task.preMerge.commands = [
    { id: 'cmd-test', command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 },
    { id: 'cmd-typecheck', command: 'npm', args: ['run', 'typecheck'], env: {}, timeoutSeconds: 120 },
  ];
  seed.verify.task.preMerge.critics = [
    {
      id: 'critic-correctness',
      name: 'Correctness',
      issuePrompt:
        "Review the diff for {title}. Flag correctness bugs, missing edge cases, and anything that breaks the issue's stated contract.",
      noIssuePrompt: 'Review the diff for correctness. There is no issue to check against.',
      model: 'claude-opus-5',
      harness: 'claude',
      timeoutSeconds: 300,
    },
    {
      id: 'critic-security',
      name: 'Security review',
      issuePrompt: 'Check the diff for security regressions relevant to {title}.',
      noIssuePrompt: 'Check the diff for security regressions.',
      model: 'gpt-5.3-codex',
      harness: 'codex',
      timeoutSeconds: 300,
    },
    { id: 'critic-narration', name: '', issuePrompt: 'Flag narration comments and commented-out code in the diff.', noIssuePrompt: 'Flag narration comments.', model: '', timeoutSeconds: 300 },
  ];
  const [config, setConfig] = useState(seed);
  return (
    <div style={{ minHeight: '100vh', background: 'var(--hm-canvas)', padding: 24 }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <section
          style={{
            background: 'var(--hm-surface)',
            borderRadius: 12,
            boxShadow: 'var(--hm-shadow-card)',
            padding: 20,
          }}
        >
          <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 700 }}>Verification</h2>
          <p style={{ margin: '2px 0 16px', color: 'var(--hm-muted)', fontSize: 13 }}>
            What runs before work merges, in order.
          </p>
          <GlobalVerificationSettings config={config} setConfig={setConfig} fieldErrors={{}} />
        </section>
      </div>
    </div>
  );
}

function BoardStory() {
  return (
    <StoryFrame style={{ padding: 24 }}>
      <Board
        tasks={boardTasks}
        loading={false}
        epics={[boardEpic, doneEpic]}
        hasHistory={true}
        onOpen={() => {}}
        onOpenTask={() => {}}
        onNewTask={() => {}}
        onOpenEpic={() => {}}
      />
    </StoryFrame>
  );
}

function CriticRunningStory() {
  const runningCritic: VerifierStatus[] = [{ mechanism: 'critic', state: 'running', reason: null, harness: 'claude' }];
  return (
    <StoryFrame style={{ padding: 30, maxWidth: 900 }}>
      <Verification attempts={[]} statuses={runningCritic} run={runs[2]!} only="critic" />
    </StoryFrame>
  );
}

function CriticPromptsStory() {
  return (
    <StoryFrame style={{ padding: 30, maxWidth: 900 }}>
      <Verification attempts={storyVerificationAttempts} statuses={verifierStatuses} run={runs[2]!} only="critic" />
      <CriticSessions attempts={storyVerificationAttempts} run={runs[2]!} />
    </StoryFrame>
  );
}

function ResolvedPromptsStory() {
  const ev = (i: number, payload: AttemptLogEvent['payload']): AttemptLogEvent => ({ id: i, seq: i, ts: 1_756_000_000_000 + i * 1000, type: 'session_update', payload });
  const lifecycle = (i: number, payload: Record<string, unknown>) => ({ ...ev(i, { sessionUpdate: '' }), type: 'lifecycle', payload }) as unknown as AttemptLogEvent;
  const events: AttemptLogEvent[] = [
    ev(1, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Implemented the change; finishing now.' } }),
    ev(3, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Committed. Merging into develop.' } }),
    lifecycle(4, { event: 'merge-conflict-resolve', locator: 'attempt-1', promptIndex: 1 }),
  ];
  return (
    <StoryFrame style={{ padding: 30, maxWidth: 760, margin: '0 auto' }}>
      <ChatTranscript events={events} unavailable={false} model="claude-sonnet-5-5" agent="Claude" stepLabel="Implementation" attemptId={1} />
    </StoryFrame>
  );
}

function TranscriptStory() {
  const ev = (i: number, payload: AttemptLogEvent['payload']): AttemptLogEvent => ({ id: i, seq: i, ts: 1_756_000_000_000 + i * 1000, type: 'session_update', payload });
  const codexEvents: AttemptLogEvent[] = [
    ev(1, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Identifying required skills and tools**\n\n' } }),
    ev(2, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Planning mandatory parallel subagents**\n\n' } }),
    ev(3, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "I'll take issue #479 through implementation, verification, review, then commit." } }),
    ev(4, { sessionUpdate: 'tool_call', toolCallId: 't1', title: "exec sed -n '1,240p' /home/workspace/.agents/skills/implement/SKILL.md && printf 'available tools'", status: 'completed' }),
    ev(5, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'exec gh issue view 479 --repo mintopia/harmonic --comments (+1)', status: 'completed' }),
    ev(6, { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'jcodemunch.order get_ranked_context', status: 'completed' }),
    ev(7, { sessionUpdate: 'tool_call', toolCallId: 't4', title: 'collaboration.spawn_agent issue_analysis', status: 'completed' }),
    ev(8, { sessionUpdate: 'tool_call', toolCallId: 't5', title: 'apply_patch tests/settings-store.test.ts (+1)', status: 'completed' }),
    ev(9, { sessionUpdate: 'tool_call', toolCallId: 't6', title: 'exec npx vitest run tests/settings-store.test.ts', status: 'failed' }),
  ];
  return (
    <StoryFrame style={{ padding: 30, maxWidth: 760, margin: '0 auto' }}>
      <ChatTranscript events={codexEvents} unavailable={false} model="gpt-5.6-sol" agent="Codex" stepLabel="Implement" />
    </StoryFrame>
  );
}

function MultiTurnStory() {
  const ev = (i: number, payload: AttemptLogEvent['payload'], type = 'session_update'): AttemptLogEvent => ({ id: i, seq: i, ts: 1_756_000_000_000 + i * 1000, type: type as 'session_update', payload });
  const lifecycle = (i: number, event: string, extra: Record<string, unknown> = {}) => ev(i, { sessionUpdate: '', event, ...extra } as AttemptLogEvent['payload'], 'lifecycle');
  const say = (i: number, text: string) => ev(i, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  const events: AttemptLogEvent[] = [
    lifecycle(1, 'prompt_sent'),
    say(2, 'Implemented the change; tests still to run.'),
    ev(3, { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Edit src/widget.ts', status: 'completed' }),
    lifecycle(4, 'steer_delivered', { text: 'Use the existing cache helper.' }),
    lifecycle(5, 'prompt_sent'),
    say(6, 'Switched to the cache helper.'),
    lifecycle(7, 'continue', { attempt: 1, locator: 'implementation/prompt.md', promptIndex: 2 }),
    lifecycle(8, 'prompt_sent'),
    say(9, 'Ran the tests; they pass. Changes are not committed yet.'),
    lifecycle(10, 'finished', { stopReason: 'end_turn' }),
    lifecycle(11, 'commit-nudge', { locator: 'implementation/prompt.md', promptIndex: 3 }),
    lifecycle(12, 'prompt_sent'),
    say(13, 'Committed the work.'),
  ];
  return (
    <StoryFrame style={{ padding: 30, maxWidth: 760, margin: '0 auto' }}>
      <PromptSent prompt={"Implement #801: render each turn's Resolved Prompt inline.\n\n---\n\nAcceptance: every turn's prompt renders whole, even when the ticket body contains a rule."} />
      <ChatTranscript
        events={events}
        unavailable={false}
        model="claude-sonnet-4-6"
        agent="Claude"
        stepLabel="Implementation"
        turnPrompts={[
          'Use the existing cache helper.',
          'Continue: run the tests, then commit.',
          'Your implementation left uncommitted changes. Commit the completed work now, then finish.',
        ]}
      />
    </StoryFrame>
  );
}

function TimelineStory() {
  return (
    <StoryFrame style={{ padding: 30, maxWidth: 760, margin: '0 auto' }}>
      <LifecycleTimeline events={timeline} following={false} onToggleFollow={() => {}} />
    </StoryFrame>
  );
}

function MergeStory() {
  const cardStyle = { background: 'var(--hm-surface)', border: '1px solid var(--hm-hairline)', borderRadius: 8, padding: 20 };
  return (
    <StoryFrame style={{ padding: 30, display: 'grid', gap: 24, maxWidth: 720, margin: '0 auto' }}>
      <div style={cardStyle}><MergeProgress steps={mergedSteps} /></div>
      <div style={cardStyle}><MergeProgress steps={revertedSteps} /></div>
      <div style={cardStyle}><MergeProgress steps={reconciledSteps} /></div>
      <div style={cardStyle}><MergeProgress steps={rebuildingSteps} /></div>
      <div style={{ ...cardStyle, padding: 0 }}><EpicIntegrationBar epic={{ ...boardEpic, mergeSteps: mergedSteps }} /></div>
    </StoryFrame>
  );
}

function ComposeStory() {
  return (
    <StoryFrame style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div style={{ flex: 1 }} />
      <Composer
        config={storyConfig}
        workspace={null}
        conversation={null}
        events={[]}
        expanded
        onSend={async () => ({ queued: false })}
      />
    </StoryFrame>
  );
}

function FleetTimelineStory() {
  return (
    <StoryFrame style={{ padding: 24 }}>
      <TimelinePage workspaceId={1} onOpenTask={() => {}} />
    </StoryFrame>
  );
}

function StatsStory() {
  return (
    <StoryFrame style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <StatsPage workspaceId={1} />
    </StoryFrame>
  );
}

function ConversationsStory() {
  return (
    <StoryFrame style={{ height: '100vh' }}>
      <ConversationsPage
        config={storyConfig}
        workspace={storyWorkspaces[0]!}
        conversationId={1}
        onConversationChange={() => {}}
      />
    </StoryFrame>
  );
}

function ActivityStory() {
  return (
    <StoryFrame style={{ padding: '28px 32px 48px' }}>
      <ActivityView config={storyConfig} />
    </StoryFrame>
  );
}

function FilesStory() {
  const filesWorkspace = { ...storyWorkspaces[0]!, id: 1, name: 'harmonic-core', color: '#3AA0FA', excludedDirectories: ['node_modules'] };
  return (
    <StoryFrame style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <FilesPage workspace={filesWorkspace} selectedPath={'src/config.ts'} onSelectFile={() => {}} onWorkspaceSaved={() => {}} />
    </StoryFrame>
  );
}

function CodeStory() {
  const sample = `import { parse } from 'yaml';
import baselineYaml from './baseline.yaml?raw';

/** Per-workspace guardrail ceilings, resolved fleet-wide then per task. */
export interface WorkspaceConfig {
  maxAttempts: number;
  tokenBudget: number | null;
  wallClockCapMs: number | null;
}

export const GUARDRAIL_DEFAULTS = {
  maxAttempts: 6,
  tokenBudget: null,
} as const;

// A task-level override still wins where present.
export function resolveGuardrails(task: Task, workspace: WorkspaceConfig) {
  return { ...GUARDRAIL_DEFAULTS, ...workspace, ...task.overrides };
}

export const config = parse(baselineYaml);
`;
  return (
    <StoryFrame style={{ height: '100vh', background: 'var(--hm-sunken)', display: 'flex', flexDirection: 'column', padding: 0 }}>
      <CodeViewer path="config.ts" text={sample} onChange={() => {}} onSave={() => {}} />
    </StoryFrame>
  );
}

function DashboardStory() {
  return (
    <StoryFrame style={{ padding: 24 }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <GlobalDashboard pendingPermissions={2} hostLoad={{ load1: 3.2, load5: 2.8, load15: 2.1, cores: 8, saturated: false }} onNavigate={() => {}} onOpenWorkspace={() => {}} />
      </div>
    </StoryFrame>
  );
}

const exportStory: TaskExportStatus = {
  exportable: true,
  latest: {
    name: '185-done-2026-09-30T11-42-07Z.tar.gz',
    disposition: 'done',
    builtAt: '2026-09-30T11:42:07.000Z',
    bytes: 19_293_798,
    partial: params.get('partial') === '1',
    redactions: { 'github-token': 3, bearer: 4 },
    destinations: [
      { destination: 'directory', location: '/srv/harmonic-exports', status: 'succeeded', lastAttemptAt: '2026-09-30T11:42:09.000Z', file: '/srv/harmonic-exports/185.tar.gz', error: null, retry: null },
      { destination: 's3', location: 's3://acme-audit/harmonic/', status: 'failed', lastAttemptAt: '2026-09-30T11:47:12.000Z', file: null, error: 'AccessDenied: s3:PutObject', retry: { count: 1, max: 3, nextRetryAt: new Date(Date.now() + 27 * 60_000).toISOString(), exhausted: false } },
    ],
  },
  earlier: [
    { name: '185-cancelled-2026-09-29T09-14-52Z.tar.gz', disposition: 'cancelled', builtAt: '2026-09-29T09:14:52.000Z', bytes: 4_300_000, partial: false, redactions: null, destinations: [{ destination: 'directory', location: null, status: 'succeeded', lastAttemptAt: '2026-09-29T09:14:53.000Z', file: null, error: null, retry: null }] },
  ],
};

function ExportStory() {
  return (
    <StoryFrame style={{ padding: 30, maxWidth: 820, margin: '0 auto' }}>
      <ExportPanel target={{ key: 'task:185', noun: 'Task', load: async () => exportStory, exportAgain: async () => ({ outcomes: [], export: exportStory }), downloadUrl: '/api/tasks/185/export/download' }} finished refreshKey={0} />
    </StoryFrame>
  );
}

function HintsStory() {
  return (
    <StoryFrame style={{ padding: '8px 0' }}>
      <HintBanner tone="ready" onDismiss={() => {}}>
        Your first task is ready, but nothing's running it yet. Press <span className="font-semibold text-ink">Run now</span> on the card, or turn the{' '}
        <span className="font-semibold text-ink">Auto-runner</span> on above.
      </HintBanner>
      <HintBanner tone="await" onDismiss={() => {}}>
        A ticket is escalated. Open it to read why and the changes so far, then <span className="font-semibold text-ink">Accept</span> to merge as-is,{' '}
        <span className="font-semibold text-ink">Retry</span> with guidance for the next attempt, or <span className="font-semibold text-ink">Close</span> it.
      </HintBanner>
    </StoryFrame>
  );
}

function ArchiveStory() {
  return (
    <StoryFrame style={{ padding: 30, maxWidth: 760, margin: '0 auto' }}>
      <ChatTranscript events={criticLog as AttemptLogEvent[]} unavailable={false} model="opus-4.8" agent="claude" stepLabel="Critic" fromArchive />
    </StoryFrame>
  );
}

function SettingsPageStory() {
  return (
    <StoryFrame style={{ padding: 24 }}>
      <SettingsPage onSaved={() => {}} />
    </StoryFrame>
  );
}

function GuardrailStory() {
  return (
    <StoryFrame>
      <ExtendGuardrailDialog taskId={172} onClose={() => {}} onDone={() => {}} extend={async () => {}} />
    </StoryFrame>
  );
}

function EpicStory() {
  return (
    <StoryFrame style={{ height: '100vh' }}>
      <EpicPage epicRef={boardEpic.ref} workspaceId={1} onClose={() => {}} onOpenTask={() => {}} selection={{ kind: 'none' }} onSelect={() => {}} />
    </StoryFrame>
  );
}

function TicketStory() {
  return (
    <StoryFrame style={{ height: '100vh' }}>
      <TicketPage
        task={task}
        onEdit={() => {}}
        onChanged={() => {}}
        onClose={() => {}}
        onOpenTask={() => {}}
        selection={{ kind: 'none' }}
        onSelect={() => {}}
      />
    </StoryFrame>
  );
}

function TrackerStory() {
  const base: Workspace = { ...storyWorkspaces[0]!, configuredTracker: { kind: 'forgejo', settings: { host: 'git.example.net' } } };
  const [workspace, setWorkspace] = useState<Workspace>(base);
  const ctx = { surface: 'workspace' as const, config: storyConfig, workspace, pristineWorkspace: base, setWorkspace, errors: {}, blockedByRunningTask: false, onRequestDelete: () => {}, dirty: workspace !== base };
  return (
    <StoryFrame style={{ padding: 24 }}>
      <div style={{ maxWidth: 760, margin: '0 auto', display: 'grid', gap: 16 }}>
        <SettingsSection title="Issue Tracker" description="Where this Workspace's issues live."><IssueTrackerSection ctx={ctx} /></SettingsSection>
        <SettingsSection title="Code Repository" description="Where branches and pull requests live."><CodeRepositorySection ctx={ctx} /></SettingsSection>
        <SettingsSection title="Triage Labels" description="Label names for each role."><TriageLabelsSection ctx={ctx} /></SettingsSection>
      </div>
    </StoryFrame>
  );
}

if (which === 'secrets' && params.get('fail') === '1') {
  Object.assign(api, {
    setSecret: async () => {
      throw new ApiError(500, 'internal server error (ref req-4f2a9)', 'internal', 'req-4f2a9');
    },
  });
}

function SecretsStory() {
  return (
    <StoryFrame style={{ padding: 24 }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <SettingsSection title="Secrets" description="Write-only; applied immediately."><SecretField workspaceId={1} name="forgejoToken" /></SettingsSection>
      </div>
    </StoryFrame>
  );
}

function RoutingOverlayStory() {
  const route = (label: string, harness: string, model: string) => ({ label, harness, model });
  const config = { ...storyConfig, routingLabels: [route('reasoning', 'claude', 'claude-opus-5-5'), route('cheap', 'claude', 'claude-haiku-4-5')] };
  const [overlay, setOverlay] = useState<RoutingLabelOverlayEntry[] | null>([
    { kind: 'local', enabled: true, routingLabel: route('security-review', 'claude', 'claude-sonnet-4-6') },
    { kind: 'global', ref: 'reasoning', enabled: true },
    { kind: 'global', ref: 'cheap', enabled: false },
    { kind: 'local', enabled: true, routingLabel: route('Reasoning', 'claude', 'claude-sonnet-4-6') },
  ]);
  return (
    <StoryFrame style={{ padding: 24 }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <SettingsSection title="Routing Labels" description="Global rows are managed in Global settings. You can reorder them and turn them off here; labels you add are local to this Workspace.">
          <RoutingLabelOverlayEditor overlay={overlay} config={config} onChange={setOverlay} />
        </SettingsSection>
      </div>
    </StoryFrame>
  );
}

const STORIES: Record<string, () => JSX.Element> = {
  settings: SettingsStory,
  board: BoardStory,
  'critic-running': CriticRunningStory,
  'critic-prompts': CriticPromptsStory,
  'epic-critic-prompt': EpicStory,
  transcript: TranscriptStory,
  'multi-turn': MultiTurnStory,
  'resolved-prompts': ResolvedPromptsStory,
  timeline: TimelineStory,
  merge: MergeStory,
  compose: ComposeStory,
  'fleet-timeline': FleetTimelineStory,
  stats: StatsStory,
  conversations: ConversationsStory,
  activity: ActivityStory,
  files: FilesStory,
  code: CodeStory,
  dashboard: DashboardStory,
  guardrail: GuardrailStory,
  epic: EpicStory,
  'epic-done': EpicStory,
  'epic-resolver': EpicStory,
  export: ExportStory,
  hints: HintsStory,
  'settings-error': SettingsPageStory,
  'settings-page': SettingsPageStory,
  archive: ArchiveStory,
  tracker: TrackerStory,
  secrets: SecretsStory,
  'routing-overlay': RoutingOverlayStory,
};

function Story() {
  const StoryComponent = (which && STORIES[which]) || TicketStory;
  return <StoryComponent />;
}

document.documentElement.setAttribute('data-theme', theme);
ReactDOM.createRoot(document.getElementById('root')!).render(<Story />);

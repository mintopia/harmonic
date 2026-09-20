import { useState } from 'react';
import type { JSX } from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import { GlobalVerificationSettings } from '../components/VerificationSettings';
import { TicketPage } from '../components/TicketPage';
import { ChatTranscript } from '../components/ticket/ChatTranscript';
import type { AttemptLogEvent, VerifierStatus } from '../types';
import { EpicPage } from '../components/EpicPage';
import { StatsPage } from '../components/StatsPage';
import { TimelinePage } from '../components/TimelinePage';
import { Composer } from '../components/conversation/Composer';
import { ConversationsPage } from '../components/ConversationLauncher';
import { config as storyConfig, workspaces as storyWorkspaces } from './fixtures';
import { Board } from '../components/Board';
import { FilesPage } from '../components/FilesPage';
import { CodeViewer } from '../components/CodeViewer';
import { GlobalDashboard } from '../components/GlobalDashboard';
import { ExtendGuardrailDialog } from '../components/ExtendGuardrailDialog';
import { Verification } from '../components/ticket/Verification';
import { LifecycleTimeline } from '../components/ticket/LifecycleTimeline';
import { MergeProgress } from '../components/MergeProgress';
import { EpicIntegrationBar } from '../components/EpicIntegrationBar';
import type { MergeStepEvent } from '../merge-progress-model';
import { task, boardEpic, boardTasks, doneEpic, runs, timeline } from './fixtures';

const mergedSteps: MergeStepEvent[] = [
  { step: 'started', baseBranch: 'develop', taskBranch: 'task/handoff-10-merge-visibility' },
  { step: 'conflict', paths: ['src/execution/merge-policy.ts', 'web/src/App.tsx'] },
  { step: 'resolve-turn', turn: 1, unmergedCount: 2 },
  { step: 'post-check-skipped', mergeOid: '4f7a1c9e2b3d5a6f8091' },
  { step: 'merged', mergeOid: '4f7a1c9e2b3d5a6f8091' },
];

const revertedSteps: MergeStepEvent[] = [
  { step: 'started', baseBranch: 'develop', taskBranch: 'task/schema-sync-rewrite' },
  { step: 'post-check-passed', mergeOid: 'aa11bb22cc33dd44ee55' },
  { step: 'reverted', mergeOid: '9c8d7e6f5a4b3c2d1e0f', revertOid: '112233445566778899aa' },
  { step: 'escalated', reason: 'post-merge-red', message: 'The post-merge check on develop failed after merging task/schema-sync-rewrite; the merge was reverted so the base stays green.\n\nFailing output:\n  FAIL tests/schema-sync.test.ts > drops a removed column' },
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

const STORIES: Record<string, () => JSX.Element> = {
  settings: SettingsStory,
  board: BoardStory,
  'critic-running': CriticRunningStory,
  transcript: TranscriptStory,
  timeline: TimelineStory,
  merge: MergeStory,
  compose: ComposeStory,
  'fleet-timeline': FleetTimelineStory,
  stats: StatsStory,
  conversations: ConversationsStory,
  files: FilesStory,
  code: CodeStory,
  dashboard: DashboardStory,
  guardrail: GuardrailStory,
  epic: EpicStory,
};

function Story() {
  const StoryComponent = (which && STORIES[which]) || TicketStory;
  return <StoryComponent />;
}

document.documentElement.setAttribute('data-theme', theme);
ReactDOM.createRoot(document.getElementById('root')!).render(<Story />);

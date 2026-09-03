/* eslint-disable */
import ReactDOM from 'react-dom/client';
import '../index.css';
import { TicketPage } from '../components/TicketPage';
import { ChatTranscript } from '../components/ticket/ChatTranscript';
import type { AttemptLogEvent } from '../types';
import { EpicPage } from '../components/EpicPage';
import { Board } from '../components/Board';
import { Verification } from '../components/ticket/Verification';
import { task, boardEpic, boardTasks, doneEpic, runs } from './fixtures';

const params = new URLSearchParams(window.location.search);
const which = params.get('story');
const theme = params.get('theme') === 'light' ? 'light' : 'dark';

function Story() {
  if (which === 'board') {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--hm-canvas)', padding: 24 }}>
        <Board
          tasks={boardTasks}
          loading={false}
          epics={[boardEpic, doneEpic]}
          onOpen={() => {}}
          onOpenTask={() => {}}
          onNewTask={() => {}}
          onOpenEpic={() => {}}
        />
      </div>
    );
  }
  if (which === 'critic-running') {
    const runningCritic = [{ mechanism: 'critic', state: 'running', reason: null }] as any;
    return (
      <div style={{ minHeight: '100vh', background: 'var(--hm-canvas)', padding: 30, maxWidth: 900 }}>
        <Verification attempts={[]} statuses={runningCritic} run={runs[2] as any} only="critic" criticAgent="Codex" />
      </div>
    );
  }
  if (which === 'transcript') {
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
      <div style={{ minHeight: '100vh', background: 'var(--hm-canvas)', padding: 30, maxWidth: 760, margin: '0 auto' }}>
        <ChatTranscript events={codexEvents} unavailable={false} model="gpt-5.6-sol" agent="Codex" stepLabel="Implement" />
      </div>
    );
  }
  if (which === 'epic') {
    return (
      <div style={{ height: '100vh', background: 'var(--hm-canvas)' }}>
        <EpicPage epicRef={boardEpic.ref} workspaceId={1} onClose={() => {}} onOpenTask={() => {}} selection={{ kind: 'none' }} onSelect={() => {}} />
      </div>
    );
  }
  return (
    <div style={{ height: '100vh', background: 'var(--hm-canvas)' }}>
      <TicketPage
        task={task as any}
        onEdit={() => {}}
        onChanged={() => {}}
        onClose={() => {}}
        onOpenTask={() => {}}
        selection={{ kind: 'none' }}
        onSelect={() => {}}
      />
    </div>
  );
}

document.documentElement.setAttribute('data-theme', theme);
ReactDOM.createRoot(document.getElementById('root')!).render(<Story />);

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptLog, withOperatorMessages } from '../src/execution/transcript-log.js';

describe('native transcript log parser', () => {
  it('reads Codex JSONL and keeps only the selected Run window', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'harmonic-codex-log-')), 'rollout.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-08-21T10:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'earlier run' } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'selected run' }] } }),
      ].join('\n'),
    );

    await expect(
      readTranscriptLog({ harness: 'codex', path: file, startedAt: Date.parse('2026-08-21T10:00:30.000Z'), finishedAt: null }),
    ).resolves.toEqual({
      status: 'available',
      events: [
        {
          id: 1,
          seq: 1,
          ts: Date.parse('2026-08-21T10:01:00.000Z'),
          type: 'session_update',
          payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'selected run' } },
        },
      ],
    });
  });

  it('surfaces Codex reasoning summaries and tool calls, never encrypted reasoning', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'harmonic-codex-log-')), 'rollout.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'planning the edit' }], encrypted_content: 'gAAAopaque' } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:01.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_a', name: 'exec', input: 'ls' } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:02.000Z', type: 'response_item', payload: { type: 'function_call', id: 'fc_1', name: 'send_message', namespace: 'collaboration', arguments: '{}' } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:03.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAopaque' } }),
      ].join('\n'),
    );

    await expect(
      readTranscriptLog({ harness: 'codex', path: file, startedAt: Date.parse('2026-08-21T10:00:30.000Z'), finishedAt: null }),
    ).resolves.toEqual({
      status: 'available',
      events: [
        { id: 1, seq: 1, ts: Date.parse('2026-08-21T10:01:00.000Z'), type: 'session_update', payload: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'planning the edit\n\n' } } },
        { id: 2, seq: 2, ts: Date.parse('2026-08-21T10:01:01.000Z'), type: 'session_update', payload: { sessionUpdate: 'tool_call', toolCallId: 'call_a', title: 'exec ls', status: 'completed' } },
        { id: 3, seq: 3, ts: Date.parse('2026-08-21T10:01:02.000Z'), type: 'session_update', payload: { sessionUpdate: 'tool_call', toolCallId: 'fc_1', title: 'collaboration.send_message', status: 'completed' } },
      ],
    });
  });

  it('drops the duplicate Codex writes as both event_msg and response_item', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'harmonic-codex-log-')), 'rollout.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'the same message' } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'the same message' }] } }),
      ].join('\n'),
    );

    await expect(readTranscriptLog({ harness: 'codex', path: file, startedAt: 0, finishedAt: null })).resolves.toMatchObject({
      status: 'available',
      events: [{ payload: { content: { text: 'the same message' } } }],
    });
  });

  it('keeps a response whose matching event_msg is outside the selected Run window', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'harmonic-codex-log-')), 'rollout.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-08-21T10:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'same message' } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'same message' }] } }),
      ].join('\n'),
    );

    await expect(
      readTranscriptLog({ harness: 'codex', path: file, startedAt: Date.parse('2026-08-21T10:00:30.000Z'), finishedAt: null }),
    ).resolves.toMatchObject({
      status: 'available',
      events: [{ payload: { content: { text: 'same message' } } }],
    });
  });

  it('keeps consecutive identical Claude messages', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'harmonic-claude-log-')), 'session.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'assistant', message: { content: [{ type: 'text', text: 'repeat this' }] } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:01.000Z', type: 'assistant', message: { content: [{ type: 'text', text: 'repeat this' }] } }),
      ].join('\n'),
    );

    await expect(readTranscriptLog({ harness: 'claude', path: file, startedAt: 0, finishedAt: null })).resolves.toMatchObject({
      status: 'available',
      events: [
        { payload: { content: { text: 'repeat this' } } },
        { payload: { content: { text: 'repeat this' } } },
      ],
    });
  });

  it('keeps consecutive identical Codex response messages', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'harmonic-codex-log-')), 'rollout.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'repeat this' }] } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'repeat this' }] } }),
      ].join('\n'),
    );

    await expect(readTranscriptLog({ harness: 'codex', path: file, startedAt: 0, finishedAt: null })).resolves.toMatchObject({
      status: 'available',
      events: [
        { payload: { content: { text: 'repeat this' } } },
        { payload: { content: { text: 'repeat this' } } },
      ],
    });
  });

  it('folds the command into an exec title and the file path into a Claude tool title', async () => {
    const codex = join(mkdtempSync(join(tmpdir(), 'harmonic-codex-log-')), 'rollout.jsonl');
    writeFileSync(
      codex,
      JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: '{"command":["bash","-lc","npm test"]}' } }),
    );
    await expect(readTranscriptLog({ harness: 'codex', path: codex, startedAt: 0, finishedAt: null })).resolves.toMatchObject({
      status: 'available',
      events: [{ payload: { title: 'exec bash -lc npm test' } }],
    });

    const claude = join(mkdtempSync(join(tmpdir(), 'harmonic-claude-log-')), 'session.jsonl');
    writeFileSync(
      claude,
      JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'web/src/ui.ts' } }] } }),
    );
    await expect(readTranscriptLog({ harness: 'claude', path: claude, startedAt: 0, finishedAt: null })).resolves.toMatchObject({
      status: 'available',
      events: [{ payload: { title: 'Edit web/src/ui.ts' } }],
    });
  });

  it('unwraps a Codex exec JS harness snippet to the underlying action', async () => {
    const title = async (input: string) => {
      const file = join(mkdtempSync(join(tmpdir(), 'harmonic-codex-log-')), 'rollout.jsonl');
      writeFileSync(file, JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c', name: 'exec', input } }));
      const log = await readTranscriptLog({ harness: 'codex', path: file, startedAt: 0, finishedAt: null });
      return log.status === 'available' ? (log.events[0]!.payload as { title: string }).title : null;
    };

    expect(await title('const r = await tools.exec_command({"cmd":"npm test","workdir":"/w","yield_time_ms":10000});\ntext(r.output);')).toBe('exec npm test');
    expect(await title('const patch = "*** Begin Patch\\n*** Update File: web/src/ui.ts\\n"; await tools.apply_patch(patch);')).toBe('apply_patch web/src/ui.ts');
    expect(await title('const r = await tools.mcp__jcodemunch__order({action:"get_ranked_context",args:{repo:"x"}}); text(r);')).toBe('jcodemunch.order get_ranked_context');
    expect(await title('const matches = ALL_TOOLS.filter(x => /comment/i.test(x.name)); text(matches);')).toBe('exec const matches = ALL_TOOLS.filter(x => /comment/i.test(x.name)); text(matches);');
  });

  it('names a Codex spawn_agent by its task instead of its encrypted message', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'harmonic-codex-log-')), 'rollout.jsonl');
    writeFileSync(
      file,
      JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'response_item', payload: { type: 'function_call', id: 'fc', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'issue_analysis', model: 'gpt-5.6-sol', message: 'gAAAAABopaqueblob' }) } }),
    );
    await expect(readTranscriptLog({ harness: 'codex', path: file, startedAt: 0, finishedAt: null })).resolves.toMatchObject({
      status: 'available',
      events: [{ payload: { title: 'collaboration.spawn_agent issue_analysis' } }],
    });
  });
});

describe('withOperatorMessages', () => {
  const ev = (id: number, ts: number, text: string) => ({
    id,
    seq: id,
    ts,
    type: 'session_update' as const,
    payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });

  it('returns the events untouched when there are no operator messages', () => {
    const events = [ev(1, 100, 'a'), ev(2, 200, 'b')];
    expect(withOperatorMessages(events, [])).toBe(events);
  });

  it('interleaves steers by timestamp, re-sequencing, as operator_message rows', () => {
    const events = [ev(1, 100, 'first'), ev(2, 300, 'second')];
    const merged = withOperatorMessages(events, [{ ts: 200, text: 'try the other file', queued: false }]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(merged.map((e) => (e.payload as { content?: { text?: string } }).content?.text)).toEqual([
      'first',
      'try the other file',
      'second',
    ]);
    const op = merged[1]!.payload as { sessionUpdate: string; queued: boolean };
    expect(op.sessionUpdate).toBe('operator_message');
    expect(op.queued).toBe(false);
  });
});

describe('Claude transcript: Subagent lanes and tool-call detail', () => {
  const claudeLine = (ts: string, content: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content }, ...extra });

  it('folds each Subagent transcript in, tagged with the Agent call that spawned it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-claude-log-'));
    const root = join(dir, 'sess.jsonl');
    writeFileSync(
      root,
      [
        claudeLine('2026-08-21T10:01:00.000Z', [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'Map the callers', subagent_type: 'Explore', prompt: 'long prompt' } }]),
        claudeLine('2026-08-21T10:01:05.000Z', [{ type: 'text', text: 'done' }]),
      ].join('\n'),
    );
    const subDir = join(dir, 'sess', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Map the callers', toolUseId: 'toolu_1' }));
    writeFileSync(
      join(subDir, 'agent-abc.jsonl'),
      [
        claudeLine('2026-08-21T10:01:02.000Z', [{ type: 'text', text: 'looking' }], { agentId: 'abc', isSidechain: true }),
        claudeLine('2026-08-21T10:01:03.000Z', [{ type: 'tool_use', id: 'toolu_2', name: 'Grep', input: { pattern: 'foo', path: 'src' } }], { agentId: 'abc', isSidechain: true }),
      ].join('\n'),
    );

    const log = await readTranscriptLog({ harness: 'claude', path: root, startedAt: Date.parse('2026-08-21T10:00:00.000Z'), finishedAt: null });
    expect(log.status).toBe('available');
    const events = log.status === 'available' ? log.events : [];
    expect(events.map((e) => [e.id, e.payload.sessionUpdate, (e.payload._meta as { claudeCode?: { parentToolUseId?: string } } | undefined)?.claudeCode?.parentToolUseId ?? null])).toEqual([
      [1, 'tool_call', null],
      [2, 'agent_message_chunk', 'toolu_1'],
      [3, 'tool_call', 'toolu_1'],
      [4, 'agent_message_chunk', null],
    ]);
    expect(events[0]!.payload).toMatchObject({ title: 'Agent Map the callers (Explore)', _meta: { claudeCode: { toolName: 'Agent' } } });
    expect(events[2]!.payload).toMatchObject({ title: 'Grep foo in src' });
  });

  it('names what a Skill, Agent, TodoWrite or front-door MCP call actually did', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'harmonic-claude-log-')), 'sess.jsonl');
    writeFileSync(
      file,
      [
        claudeLine('2026-08-21T10:01:00.000Z', [
          { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'cloudagent' } },
          { type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'ponytail', args: 'lite' } },
          { type: 'tool_use', id: 't3', name: 'TodoWrite', input: { todos: [{}, {}, {}] } },
          { type: 'tool_use', id: 't4', name: 'mcp__jcodemunch__order', input: { action: 'resolve_repo', args: { path: '.' } } },
          { type: 'tool_use', id: 't5', name: 'ToolSearch', input: { query: 'select:Read' } },
          { type: 'tool_use', id: 't6', name: 'Agent', input: { prompt: 'Review the diff', subagent_type: 'code-reviewer' } },
        ]),
      ].join('\n'),
    );
    const log = await readTranscriptLog({ harness: 'claude', path: file, startedAt: 0, finishedAt: null });
    expect(log.status === 'available' ? log.events.map((e) => e.payload.title) : []).toEqual([
      'Skill /cloudagent',
      'Skill /ponytail lite',
      'TodoWrite 3 todos',
      'mcp__jcodemunch__order resolve_repo {"path":"."}',
      'ToolSearch select:Read',
      'Agent Review the diff (code-reviewer)',
    ]);
  });
});

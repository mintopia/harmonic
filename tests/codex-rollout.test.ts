import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterFor } from '../src/execution/harness/registry.js';

const codex = adapterFor('codex');
const events = (entry: unknown, firstId = 1) => codex.transcript!.events(entry, firstId);

const callEntry = (payload: Record<string, unknown>, timestamp?: string) => ({
  type: 'response_item',
  ...(timestamp ? { timestamp } : {}),
  payload: { type: 'function_call', ...payload },
});
const toolCall = (entry: unknown) => (events(entry)[0]?.payload as { title?: string; toolCallId?: string; status?: string }) ?? null;

describe('codex transcript events', () => {
  it('ignores entries without a record payload', () => {
    expect(events(null)).toEqual([]);
    expect(events({ type: 'event_msg' })).toEqual([]);
    expect(events({ type: 'event_msg', payload: 'x' })).toEqual([]);
  });

  it('maps assistant messages from both rollout shapes and numbers ids from firstId', () => {
    const fromEvent = { type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'agent_message', message: 'hello' } };
    expect(events(fromEvent, 7)).toEqual([
      {
        id: 7,
        seq: 7,
        ts: Date.parse('2026-01-01T00:00:00Z'),
        type: 'session_update',
        payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
      },
    ]);
    const fromResponse = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } };
    expect(events(fromResponse)[0]).toMatchObject({ ts: 0, payload: { content: { text: 'hi' } } });
    expect(events({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'no' }] } })).toEqual([]);
  });

  it('emits one thought chunk per non-empty reasoning summary part, each ending in a blank line', () => {
    const entry = {
      type: 'response_item',
      payload: {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'A' }, { type: 'text', text: 'B' }, { type: 'other', text: 'C' }, { type: 'text', text: '' }, { type: 'text', text: 4 }, 'x'],
      },
    };
    const out = events(entry, 3);
    expect(out.map((e) => [e.id, e.payload])).toEqual([
      [3, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'A\n\n' } }],
      [4, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'B\n\n' } }],
    ]);
    expect(events({ type: 'response_item', payload: { type: 'reasoning', summary: 'nope' } })).toEqual([]);
  });

  it('titles tool calls: namespace, id fallbacks, default name, status', () => {
    expect(toolCall(callEntry({ name: 'search', namespace: 'functions', call_id: 'c1', arguments: { query: 'q' } }))).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'functions.search q',
      status: 'completed',
    });
    expect(toolCall(callEntry({ name: 'read', id: 'i1', namespace: '' }))).toMatchObject({ toolCallId: 'i1', title: 'read' });
    expect(toolCall(callEntry({ call_id: 7, id: 'i2' }))).toMatchObject({ toolCallId: 'i2', title: 'Tool call' });
    expect(toolCall(callEntry({ name: 'read', namespace: { bad: true } }))).toMatchObject({ toolCallId: 'read', title: 'read' });
    expect(toolCall({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'x', call_id: 'c' } })).toMatchObject({ toolCallId: 'c' });
  });

  it('prefers the readable task_name / target of a collaboration call, parsing string args', () => {
    expect(toolCall(callEntry({ name: 'spawn', arguments: { task_name: 'review\nplease', message: 'enc' } }))?.title).toBe('spawn review please');
    expect(toolCall(callEntry({ name: 'spawn', arguments: '{"target":"/root/a"}' }))?.title).toBe('spawn /root/a');
    expect(toolCall(callEntry({ name: 'spawn', arguments: 'not json' }))?.title).toBe('spawn not json');
    expect(toolCall(callEntry({ name: 'spawn', arguments: { task_name: '', command: 'ls' } }))?.title).toBe('spawn ls');
  });

  it('unwraps exec scripts to the underlying action', () => {
    const exec = (input: unknown) => toolCall(callEntry({ name: 'exec', input }))?.title;
    expect(exec('*** Update File: src/a.ts\n*** Add File: b.ts')).toBe('apply_patch src/a.ts (+1)');
    expect(exec('*** Delete File: only.ts')).toBe('apply_patch only.ts');
    expect(exec('tools.exec_command({"cmd":"ls -la"}) ; tools.exec_command({"cmd":"pwd"})')).toBe('exec ls -la (+1)');
    expect(exec('tools.exec_command({"cmd":"ls"})')).toBe('exec ls');
    expect(exec('tools.mcp__srv__do({ action: "go", x: 1 })')).toBe('srv.do go');
    expect(exec('tools.mcp__srv__do({ x: 1 })')).toBe('srv.do');
    expect(exec('tools.other_tool(1)')).toBe('other_tool');
    expect(exec('const x = 1;')).toBe('exec const x = 1;');
    expect(exec('plain command')).toBe('exec plain command');
    expect(toolCall(callEntry({ name: 'shell', input: 'tools.x(1)' }))?.title).toBe('shell tools.x(1)');
  });

  it('flags a response_item message that repeats the previous event_msg as a duplicate', () => {
    const response = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'same' }] } };
    const event = { type: 'event_msg', payload: { type: 'agent_message', message: 'same' } };
    const other = { type: 'event_msg', payload: { type: 'agent_message', message: 'different' } };
    expect(codex.transcript!.isDuplicateMessage(response, event)).toBe(true);
    expect(codex.transcript!.isDuplicateMessage(response, other)).toBe(false);
    expect(codex.transcript!.isDuplicateMessage(event, event)).toBe(false);
  });
});

describe('codex rollout parsing', () => {
  const tokenCount = (input: number, cached: number, output: number, last?: number) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
          ...(last === undefined ? {} : { last_token_usage: { input_tokens: last } }),
        },
      },
    });
  const turn = (model: unknown) => JSON.stringify({ type: 'turn_context', payload: { model } });
  const meta = (payload: Record<string, unknown>) => JSON.stringify({ type: 'session_meta', payload });
  const setup = (files: Record<string, string[]>) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-char-'));
    const day = join(root, '2026', '08', '24');
    mkdirSync(day, { recursive: true });
    for (const [name, lines] of Object.entries(files)) writeFileSync(join(day, `rollout-x-${name}.jsonl`), lines.join('\n'));
    return root;
  };
  const parse = (root: string, sessionId = 'root') => codex.usage!.parse!({ sessionLogDir: root, cwd: '/w', sessionId })!;

  it('names a Subagent by agent_path, then payload.agent_path, then nicknames, else "subagent"', () => {
    const child = (id: string, extra: Record<string, unknown>) => [meta({ id, parent_thread_id: 'root', ...extra })];
    const root = setup({
      root: [meta({ id: 'root' })],
      a: child('a', { source: { subagent: { thread_spawn: { agent_path: 'p1', agent_nickname: 'n1' } } }, agent_path: 'p2', agent_nickname: 'n2' }),
      b: child('b', { source: { subagent: { thread_spawn: { agent_nickname: 'n1' } } }, agent_path: 'p2', agent_nickname: 'n2' }),
      c: child('c', { source: { subagent: { thread_spawn: { agent_nickname: 'n1' } } }, agent_nickname: 'n2' }),
      d: child('d', { agent_nickname: 'n2' }),
      e: child('e', { source: { subagent: { thread_spawn: { agent_path: 4 } } }, agent_path: null }),
      f: [meta({ session_id: 'f', parent_thread_id: 'root' })],
    });
    const names = Object.fromEntries(parse(root).tree.children.map((c) => [c.id, c.name]));
    expect(names).toEqual({ a: 'p1', b: 'p2', c: 'n1', d: 'n2', e: 'subagent', f: 'subagent' });
  });

  it('skips rollouts whose header is not a session_meta with an id, has no parent, or is malformed', () => {
    const root = setup({
      root: [meta({ id: 'root' })],
      noid: [meta({ parent_thread_id: 'root' })],
      noparent: [meta({ id: 'orphan' })],
      other: [JSON.stringify({ type: 'turn_context', payload: { id: 'z', parent_thread_id: 'root' } })],
      bad: ['not json'],
      unrelated: [meta({ id: 'u', parent_thread_id: 'elsewhere' })],
      nested: [meta({ id: 'n', parent_thread_id: 'ok' })],
      ok: [meta({ id: 'ok', parent_thread_id: 'root' })],
    });
    const tree = parse(root).tree;
    expect(tree.children.map((c) => c.id)).toEqual(['ok']);
    expect(tree.children[0]!.children.map((c) => c.id)).toEqual(['n']);
  });

  it('dedupes tool calls by id, qualifies them by namespace, and tracks the last tool', () => {
    const call = (payload: Record<string, unknown>) => JSON.stringify({ type: 'response_item', payload });
    const root = setup({
      root: [
        turn('m'),
        call({ type: 'function_call', call_id: 'c1', name: 'a', namespace: 'ns' }),
        call({ type: 'function_call', call_id: 'c1', name: 'a', namespace: 'ns' }),
        call({ type: 'custom_tool_call', id: 'c2', name: 'b' }),
        call({ type: 'function_call', name: 'noid' }),
        call({ type: 'function_call', name: 'noid' }),
        call({ type: 'function_call', call_id: 'c3' }),
        call({ type: 'message', name: 'ignored' }),
        tokenCount(10, 0, 1),
      ],
    });
    const parsed = parse(root);
    expect(parsed.turns).toEqual([
      { model: 'm', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, tools: ['ns.a', 'b', 'noid', 'noid'] },
    ]);
    expect(parsed.tree.lastTool).toBe('noid');
  });

  it('records context fill from last_token_usage and ignores token counts with no cumulative total', () => {
    const root = setup({
      root: [
        turn('m'),
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
        tokenCount(10, 2, 1, 9),
        tokenCount(20, 4, 2),
        turn(42),
      ],
    });
    const parsed = parse(root);
    expect(parsed.tree.contextTokens).toBe(9);
    expect(parsed.usage.models).toEqual({ m: { inputTokens: 16, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 } });
  });

  it('drops delta spend before any model is known yet still advances the baseline', () => {
    const root = setup({ root: [tokenCount(100, 0, 10), turn('m'), tokenCount(130, 10, 14)] });
    expect(parse(root).usage.models).toEqual({ m: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 0 } });
  });

  it('a Subagent baseline comes from pre-start token counts and its pre-start tool calls are discarded', () => {
    const call = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'old', name: 'forked' } });
    const root = setup({
      root: [meta({ id: 'root' })],
      child: [
        meta({ id: 'child', parent_thread_id: 'root' }),
        turn('parent-model'),
        call,
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }),
        tokenCount(100, 20, 10),
        JSON.stringify({ type: 'inter_agent_communication_metadata', payload: { trigger_turn: false } }),
        tokenCount(150, 20, 15),
        JSON.stringify({ type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } }),
        turn('child-model'),
        JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'new', name: 'fresh' } }),
        tokenCount(180, 30, 17),
      ],
    });
    const parsed = parse(root);
    expect(parsed.usage.models).toEqual({ 'child-model': { inputTokens: 20, outputTokens: 2, cacheReadTokens: 10, cacheWriteTokens: 0 } });
    expect(parsed.turns).toEqual([
      { model: 'child-model', usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 10, cacheWriteTokens: 0 }, tools: ['fresh'] },
    ]);
    expect(parsed.tree.children[0]).toMatchObject({ id: 'child', lastTool: 'fresh', model: 'child-model' });
  });
});

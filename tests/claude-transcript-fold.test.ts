import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterFor } from '../src/execution/harness/registry.js';

const parseLines = (lines: string[]) => {
  const home = mkdtempSync(join(tmpdir(), 'claude-fold-'));
  mkdirSync(join(home, '-w'), { recursive: true });
  writeFileSync(join(home, '-w', 's.jsonl'), lines.join('\n'));
  return adapterFor('claude').usage!.parse!({ sessionLogDir: home, cwd: '/w', sessionId: 's' })!;
};
const assistant = (message: Record<string, unknown>) => JSON.stringify({ type: 'assistant', message });
const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };

describe('claude transcript fold', () => {
  it('skips blank and malformed lines, and entries missing a model or usage', () => {
    const parsed = parseLines([
      '',
      '   ',
      'not json',
      'null',
      assistant({ id: 'a', usage }),
      assistant({ id: 'b', model: 'm' }),
      JSON.stringify({ type: 'user', message: { id: 'c', model: 'm', usage } }),
      assistant({ id: 'd', model: 'm', usage }),
    ]);
    expect(parsed.usage.models).toEqual({ m: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } });
    expect(parsed.tree.contextTokens).toBe(17);
    expect(parsed.turns).toEqual([{ model: 'm', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, tools: [] }]);
  });

  it('dedupes chunked messages by id, or by whole line when the id is not a string', () => {
    const noId = assistant({ id: 5, model: 'm', usage: { input_tokens: 1 } });
    const parsed = parseLines([
      assistant({ id: 'x', model: 'm', usage: { input_tokens: 1 } }),
      assistant({ id: 'x', model: 'm', usage: { input_tokens: 99 } }),
      noId,
      noId,
      assistant({ id: 6, model: 'm', usage: { input_tokens: 1 } }),
    ]);
    expect(parsed.usage.models.m).toMatchObject({ inputTokens: 3 });
    expect(parsed.turns).toHaveLength(3);
  });

  it('keeps the last tool name across a turn with no tool_use, and ignores non-string tool names', () => {
    const parsed = parseLines([
      assistant({
        id: '1',
        model: 'm',
        usage,
        content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Grep' }, { type: 'tool_use', name: 4 }, null],
      }),
      assistant({ id: '2', model: 'm', usage, content: 'plain' }),
    ]);
    expect(parsed.tree.lastTool).toBe('Grep');
    expect(parsed.turns!.map((t) => t.tools)).toEqual([['Read', 'Grep'], []]);
  });

  it('marks a Subagent spawn completed only by a tool_result with a string tool_use_id', () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-fold-done-'));
    const subs = join(home, '-w', 's', 'subagents');
    mkdirSync(subs, { recursive: true });
    writeFileSync(
      join(home, '-w', 's.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'done' }, { type: 'tool_result', tool_use_id: 9 }, { type: 'text' }, null] } }),
        JSON.stringify({ type: 'user', message: { content: 'str' } }),
      ].join('\n'),
    );
    for (const [id, toolUseId] of [['a', 'done'], ['b', 'open']] as const) {
      writeFileSync(join(subs, `agent-${id}.jsonl`), assistant({ id, model: 'm', usage }));
      writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify({ agentType: id, toolUseId, spawnDepth: 1 }));
    }
    const parsed = adapterFor('claude').usage!.parse!({ sessionLogDir: home, cwd: '/w', sessionId: 's' })!;
    const status = Object.fromEntries(parsed.tree.children.map((c) => [c.id, c.status]));
    expect(status).toEqual({ a: 'inactive', b: 'active' });
  });
});

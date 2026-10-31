#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
let cwd = process.cwd();
let turns = 0;

const sessionFile = () => {
  if (!process.env.POD_AGENT_SESSION) return null;
  const dir = join(process.env.HOME, '.claude', 'projects', '-pod');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'pod-session.jsonl');
};
const record = (entry) => {
  const file = sessionFile();
  if (file) appendFileSync(file, `${JSON.stringify(entry)}\n`);
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
  } else if (msg.method === 'session/new') {
    cwd = msg.params.cwd;
    record({ type: 'user', message: { role: 'user', content: 'héllo ✓ 日本語' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'pod-session', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'default' }, { id: 'auto', name: 'auto' }, { id: 'bypassPermissions', name: 'bypassPermissions' }] } } });
  } else if (msg.method === 'session/set_mode' || msg.method === 'session/set_model') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    setTimeout(() => prompt(msg), Number(process.env.POD_AGENT_HOLD_MS ?? 0));
  }
});

function prompt(msg) {
  let file = `agent-${++turns}.txt`;
  while (existsSync(join(cwd, file))) file = `agent-${++turns}.txt`;
  writeFileSync(join(cwd, file), 'from the agent\n');
  if (!process.env.POD_AGENT_NO_COMMIT) {
    execFileSync('git', ['add', file], { cwd });
    execFileSync('git', ['commit', '-qm', `agent ${file}`], { cwd });
  }
  record({ type: 'assistant', message: { id: `msg-${turns}`, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'done ✓ 日本語' }], usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } } });
  const text = `done ${file} token=${process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''}`;
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'pod-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
}

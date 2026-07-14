#!/usr/bin/env node
// Spike probe (issue 22): drive @agentclientprotocol/codex-acp over ACP
// (ndjson JSON-RPC on stdio), mirroring AgentDeck's Runner: no fs/terminal
// capabilities advertised, permissions auto-granted preferring allow_always.
// Captures every message verbatim to a .jsonl file.
//
// Usage: node codex-probe.mjs <capture-file> <workdir> <prompt...>
// Env:   CODEX_CONFIG      passed through to the adapter (model pinning etc.)
//        SET_MODEL         modelId for session/set_model before the prompt
//        MCP_SERVERS       JSON array for session/new mcpServers
//        CODEX_HOME        passed through (auth isolation tests)
//        ACP_ADAPTER       adapter package (default @agentclientprotocol/codex-acp)
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [captureFile, workdir, ...promptParts] = process.argv.slice(2);
const promptText = promptParts.join(' ');
if (!captureFile || !workdir || !promptText) {
  console.error('usage: codex-probe.mjs <capture> <workdir> <prompt>');
  process.exit(2);
}
mkdirSync(workdir, { recursive: true });
writeFileSync(captureFile, '');

const adapterPkg = process.env.ACP_ADAPTER ?? '@agentclientprotocol/codex-acp';
const child = spawn('npx', ['--yes', adapterPkg], {
  cwd: workdir,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, NO_BROWSER: '1' },
});

const capture = (dir, obj) => {
  appendFileSync(captureFile, JSON.stringify({ ts: Date.now(), dir, msg: obj }) + '\n');
};

let nextId = 1;
const pending = new Map();
const send = (method, params) => {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  capture('client->agent', msg);
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const respond = (id, result) => {
  const msg = { jsonrpc: '2.0', id, result };
  capture('client->agent', msg);
  child.stdin.write(JSON.stringify(msg) + '\n');
};

child.stderr.on('data', (d) => {
  capture('agent-stderr', d.toString());
  process.stderr.write(d);
});

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { capture('agent-raw', line); return; }
  capture('agent->client', msg);

  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  // Agent -> client requests: auto-handle exactly like the Runner.
  if (msg.method === 'session/request_permission') {
    const opts = msg.params?.options ?? [];
    const allow = opts.find((o) => o.kind === 'allow_always') ?? opts.find((o) => o.kind === 'allow_once') ?? opts[0];
    respond(msg.id, allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } });
    return;
  }
  if (msg.id !== undefined && msg.method) {
    // Unknown request: answer null so the agent doesn't hang.
    respond(msg.id, null);
  }
});

const die = (code, why) => {
  capture('probe', { exit: code, why });
  try { child.kill('SIGKILL'); } catch {}
  process.exit(code);
};
setTimeout(() => die(3, 'global timeout 240s'), 240_000);
child.on('exit', (code, sig) => capture('probe', { childExit: code, sig }));

try {
  const init = await send('initialize', { protocolVersion: 1, clientCapabilities: {} });
  console.error('initialized:', JSON.stringify(init));
  const mcpServers = process.env.MCP_SERVERS ? JSON.parse(process.env.MCP_SERVERS) : [];
  const sess = await send('session/new', { cwd: workdir, mcpServers });
  console.error('session current model:', JSON.stringify(sess.models?.currentModelId));
  if (process.env.SET_MODEL) {
    const set = await send('session/set_model', { sessionId: sess.sessionId, modelId: process.env.SET_MODEL });
    console.error('set_model result:', JSON.stringify(set));
  }
  const result = await send('session/prompt', {
    sessionId: sess.sessionId,
    prompt: [{ type: 'text', text: promptText }],
  });
  console.error('prompt done:', JSON.stringify(result));
  capture('probe', { promptResult: result });
  die(0, 'done');
} catch (e) {
  console.error('probe error:', e.message);
  die(1, e.message);
}

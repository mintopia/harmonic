#!/usr/bin/env node
// Spike probe: drive claude-code-acp over ACP (ndjson JSON-RPC on stdio),
// auto-grant permissions, capture every message verbatim to a .jsonl file.
//
// Usage: node acp-probe.mjs <capture-file> <workdir> <prompt...>
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [captureFile, workdir, ...promptParts] = process.argv.slice(2);
const promptText = promptParts.join(' ');
if (!captureFile || !workdir || !promptText) {
  console.error('usage: acp-probe.mjs <capture> <workdir> <prompt>');
  process.exit(2);
}
mkdirSync(workdir, { recursive: true });
writeFileSync(captureFile, '');

const adapterPkg = process.env.ACP_ADAPTER ?? 'claude-code-acp';
const child = spawn('npx', ['--yes', adapterPkg], {
  cwd: workdir,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined },
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
  // Agent -> client requests: auto-handle.
  if (msg.method === 'session/request_permission') {
    const opts = msg.params?.options ?? [];
    const allow = opts.find((o) => o.kind === 'allow_always') ?? opts.find((o) => o.kind === 'allow_once') ?? opts[0];
    respond(msg.id, { outcome: { outcome: 'selected', optionId: allow?.optionId } });
    return;
  }
  if (msg.method === 'fs/read_text_file') {
    try {
      respond(msg.id, { content: readFileSync(msg.params.path, 'utf8') });
    } catch (e) {
      respond(msg.id, { content: '' });
    }
    return;
  }
  if (msg.method === 'fs/write_text_file') {
    writeFileSync(msg.params.path, msg.params.content);
    respond(msg.id, null);
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
  const init = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  console.error('initialized:', JSON.stringify(init).slice(0, 400));
  const sess = await send('session/new', { cwd: workdir, mcpServers: [] });
  console.error('session:', JSON.stringify(sess).slice(0, 400));
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

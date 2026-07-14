#!/usr/bin/env node
// Spike prop (issue 22): a minimal streamable-HTTP MCP server exposing one
// tool, logging every request line + Authorization header to stderr so the
// probe can verify Codex honors ACP `mcpServers` HTTP entries with headers.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8977);

const respond = (res, id, result) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
};

createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    console.error(`[mcp-echo] ${req.method} ${req.url} auth=${req.headers.authorization ?? '<none>'} body=${body.slice(0, 200)}`);
    let msg = {};
    try { msg = JSON.parse(body); } catch {}
    if (msg.method === 'initialize') {
      return respond(res, msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentdeck-echo', version: '0.0.1' },
      });
    }
    if (msg.method === 'tools/list') {
      return respond(res, msg.id, {
        tools: [{
          name: 'agentdeck_echo',
          description: 'Echoes back the provided text. Call this when asked to echo.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        }],
      });
    }
    if (msg.method === 'tools/call') {
      return respond(res, msg.id, {
        content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text ?? ''}` }],
      });
    }
    // Notifications and anything else: accept.
    res.writeHead(202);
    res.end();
  });
}).listen(port, () => console.error(`[mcp-echo] listening on ${port}`));

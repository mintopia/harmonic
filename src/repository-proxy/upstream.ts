import { spawn } from 'node:child_process';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

export interface Upstream {
  advertise(service: GitService): Promise<Buffer>;
  rpc(service: GitService, body: Buffer): Promise<Buffer>;
}

export interface UpstreamAuth {
  username: string;
  token: string;
}

function runGit(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`git ${args[0]} exited ${code}: ${Buffer.concat(err).toString().trim()}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function localUpstream(path: string): Upstream {
  const subcommand = (service: GitService) => service.replace('git-', '');
  return {
    advertise: (service) => runGit([subcommand(service), '--stateless-rpc', '--advertise-refs', path]),
    rpc: (service, body) => runGit([subcommand(service), '--stateless-rpc', path], body),
  };
}

function httpUpstream(url: string, auth: UpstreamAuth | undefined): Upstream {
  const base = url.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (auth) {
    headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString('base64')}`;
  }
  async function send(target: string, init: RequestInit): Promise<Buffer> {
    const res = await fetch(target, { ...init, redirect: 'error' });
    if (!res.ok) throw new Error(`upstream responded ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return {
    advertise: (service) => send(`${base}/info/refs?service=${service}`, { headers }),
    rpc: (service, body) =>
      send(`${base}/${service}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': `application/x-${service}-request` },
        body: new Uint8Array(body),
      }),
  };
}

/** Local paths and file:// URLs run git directly; http(s) URLs are reached with the proxy's own credentials. */
export function resolveUpstream(codeRepository: string, auth: UpstreamAuth | undefined): Upstream {
  if (/^https?:\/\//.test(codeRepository)) return httpUpstream(codeRepository, auth);
  return localUpstream(codeRepository.replace(/^file:\/\//, ''));
}

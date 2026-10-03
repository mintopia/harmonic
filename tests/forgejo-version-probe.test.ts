import { describe, it, expect, vi } from 'vitest';
import { detectRepository, forgejoVersionProbe, gitlabProbe } from '../src/repository/detect.js';

const target = { host: 'forge.example', port: null, scheme: 'https' as const };
const json = (body: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body)));

describe('forgejoVersionProbe', () => {
  it('probes a public host', async () => {
    const fetchFn = json({ version: '9.0' });
    expect(await forgejoVersionProbe(fetchFn as unknown as typeof fetch)(target)).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('probes a private host', async () => {
    const fetchFn = json({ version: '9.0' });
    expect(await forgejoVersionProbe(fetchFn as unknown as typeof fetch)({ host: '10.0.0.5', port: null, scheme: 'https' })).toBe(true);
  });

  it('never follows redirects and treats a 3xx as not Forgejo', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    expect(await forgejoVersionProbe(fetchFn as unknown as typeof fetch)(target)).toBe(false);
    expect(fetchFn.mock.calls[0]).toEqual(['https://forge.example/api/v1/version', expect.objectContaining({ redirect: 'manual' })]);
  });

  it('uses the remote port and scheme', async () => {
    const fetchFn = json({ version: '9.0' });
    await forgejoVersionProbe(fetchFn as unknown as typeof fetch)({ host: 'forge.example', port: 3000, scheme: 'http' });
    expect(fetchFn.mock.calls[0]![0]).toBe('http://forge.example:3000/api/v1/version');
  });
});

describe('gitlabProbe', () => {
  it('recognises the GitLab web manifest', async () => {
    const fetchFn = json({ name: 'GitLab' });
    expect(await gitlabProbe(fetchFn as unknown as typeof fetch)(target)).toBe(true);
    expect(fetchFn.mock.calls[0]![0]).toBe('https://forge.example/-/manifest.json');
  });

  it('rejects other manifests, errors and redirects', async () => {
    expect(await gitlabProbe(json({ name: 'Other' }) as unknown as typeof fetch)(target)).toBe(false);
    expect(await gitlabProbe((async () => new Response('', { status: 404 })) as typeof fetch)(target)).toBe(false);
    expect(await gitlabProbe((async () => new Response(null, { status: 301 })) as typeof fetch)(target)).toBe(false);
  });
});

describe('detectRepository probes', () => {
  const no = async () => false;
  it('passes the http(s) remote port and scheme, but not an ssh port', async () => {
    const seen: unknown[] = [];
    const record = async (t: unknown) => { seen.push(t); return false; };
    await detectRepository('http://code.example.org:3000/o/r.git', record, no);
    await detectRepository('ssh://git@code.example.org:2222/o/r.git', record, no);
    expect(seen).toEqual([
      { host: 'code.example.org', port: 3000, scheme: 'http' },
      { host: 'code.example.org', port: null, scheme: 'https' },
    ]);
  });

  it('falls back to the GitLab probe after Forgejo', async () => {
    expect(await detectRepository('https://git.corp.test/o/r', no, async () => true)).toBe('gitlab');
    expect(await detectRepository('https://git.corp.test/o/r', async () => true, async () => true)).toBe('forgejo');
  });
});

import { describe, it, expect } from 'vitest';
import { forgejoRepository } from '../src/repository/forgejo.js';
import { parseForgejoRemote } from '../src/tracker/forgejo-client.js';
import { fakeForgejo } from './helpers/fake-forgejo.js';

describe('Forgejo Code Repository', () => {
  it('openPR posts a pull request from the branch onto the base', async () => {
    const fake = fakeForgejo({ issues: [] });
    await forgejoRepository({ baseUrl: 'https://forge.test', repo: 'owner/name', token: 'good', http: fake.http }).openPR({
      branch: 'b',
      baseBranch: 'develop',
      title: 'T',
      body: 'B',
    });
    expect(fake.pulls).toEqual([{ head: 'b', base: 'develop', title: 'T', body: 'B' }]);
    expect(fake.requests[0]!.auth).toBe('token good');
  });

  it('verify reports ok, or the failure reason', async () => {
    const fake = fakeForgejo({ issues: [] });
    const repo = (token: string) => forgejoRepository({ baseUrl: 'https://forge.test', repo: 'owner/name', token, http: fake.http });
    expect(await repo('good').verify()).toEqual({ ok: true });
    expect(await repo('bad').verify()).toMatchObject({ ok: false, reason: expect.stringContaining('401') });
  });
});

describe('parseForgejoRemote', () => {
  it.each([
    ['https://forge.example/owner/name.git', { baseUrl: 'https://forge.example', repo: 'owner/name' }],
    ['git@forge.example:owner/name.git', { baseUrl: 'https://forge.example', repo: 'owner/name' }],
    ['ssh://git@forge.example:2222/owner/name', { baseUrl: 'https://forge.example', repo: 'owner/name' }],
  ])('%s', (url, expected) => {
    expect(parseForgejoRemote(url)).toEqual(expected);
  });
});

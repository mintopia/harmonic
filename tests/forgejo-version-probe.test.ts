import { describe, it, expect, vi } from 'vitest';
import { forgejoVersionProbe, isPrivateHost } from '../src/repository/detect.js';

describe('forgejoVersionProbe', () => {
  it.each(['10.0.0.5', '127.0.0.1', '192.168.1.2', '172.20.0.1', '169.254.169.254', 'localhost', '[::1]', 'github.com', 'gitlab.com'])(
    'never fetches %s',
    async (host) => {
      const fetchFn = vi.fn();
      expect(await forgejoVersionProbe(fetchFn as unknown as typeof fetch)(host)).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('probes a public host', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ version: '9.0' })));
    expect(await forgejoVersionProbe(fetchFn as unknown as typeof fetch)('forge.example')).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe('isPrivateHost', () => {
  it('leaves public addresses alone', () => {
    expect(isPrivateHost('forge.example')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });
});

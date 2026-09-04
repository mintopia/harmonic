import type { HarnessAdapter } from './adapter.js';

export const opencodeAdapter: HarnessAdapter = {
  commandPrefix: '/',
  transcript: null,
  spawnEnv: () => ({}),
  sessionModelId: (model) => model,
  mcpServers: ({ url, token }) => [
    {
      name: 'harmonic',
      type: 'http',
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
  ],
  unattendedPermissionMode: () => undefined,
  requiresUnattendedPermissionMode: false,
  usage: null,
};

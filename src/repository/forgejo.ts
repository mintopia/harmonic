import { forgejoClient, repoPath, verifyForgejoToken, type ForgejoConnection } from '../tracker/forgejo-client.js';
import type { RepositoryAdapter } from './adapter.js';

export interface ForgejoRepositoryConfig extends ForgejoConnection {
  /** `owner/name` on the instance. */
  repo: string;
}

/** The Forgejo Code Repository over its REST API with an access token. */
export function forgejoRepository({ repo, ...connection }: ForgejoRepositoryConfig): RepositoryAdapter {
  const client = forgejoClient(connection);
  return {
    kind: 'forgejo',

    async openPR({ branch, baseBranch, title, body }) {
      await client.send('POST', `/repos/${repoPath(repo)}/pulls`, { head: branch, base: baseBranch, title, body });
    },

    async verify() {
      const result = await verifyForgejoToken(client);
      return result.ok ? { ok: true } : result;
    },
  };
}

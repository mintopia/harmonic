import { forgejoClient, repoPath, verifyForgejoToken, type ForgejoConnection } from '../tracker/forgejo-client.js';
import { z } from 'zod';
import { parseWebUrl, type RepositoryAdapter } from './adapter.js';

const pullSchema = z.object({ html_url: z.string().optional() });

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
      const pull = await client.request('POST', `/repos/${repoPath(repo)}/pulls`, pullSchema, { head: branch, base: baseBranch, title, body });
      return pull.html_url === undefined ? null : parseWebUrl(pull.html_url);
    },

    async verify() {
      const result = await verifyForgejoToken(client);
      return result.ok ? { ok: true } : result;
    },
  };
}

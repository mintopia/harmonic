import type { SecretService } from '../secrets/secret-service.js';
import type { WorkspaceTrackerSettings } from '../tracker/adapter.js';
import { forgejoSettingsSchema } from '../tracker/forgejo.js';
import { FORGEJO_TOKEN_SECRET, parseForgejoRemote, type ForgejoConnection } from '../tracker/forgejo-client.js';
import type { TrackerHttp } from '../tracker/kind.js';
import type { RepositoryAdapter } from './adapter.js';
import { cachedProbe, detectRepository, forgejoVersionProbe, type ForgejoProbe, type RepositoryKind } from './detect.js';
import { forgejoRepository } from './forgejo.js';
import { gitRepository } from './git.js';
import { githubRepository } from './github.js';
import { gitlabRepository } from './gitlab.js';
import { originRemote } from './remote.js';

const defaultProbe = cachedProbe(forgejoVersionProbe());
const defaultHttp: TrackerHttp = (url, init) => fetch(url, init);

/** The repo's Code Repository kind: the Workspace override, else detected from its `origin` remote; null when neither names one. */
export async function resolveCodeRepository(
  repoRoot: string,
  override?: RepositoryKind | null,
  probe: ForgejoProbe = defaultProbe,
  origin: () => Promise<string | null> = originRemote(repoRoot),
): Promise<RepositoryKind | null> {
  if (override) return override;
  const url = await origin();
  return url ? detectRepository(url, probe) : null;
}

/** Forgejo needs a token (a Secret), so its adapter is built only when the caller supplies one. */
export type ForgejoCredentials = Pick<ForgejoConnection, 'token' | 'http'>;

/** The repo's Code Repository adapter; null when its kind is unresolved, or Forgejo has no token. */
export async function resolveRepositoryAdapter(
  repoRoot: string,
  override?: RepositoryKind | null,
  forgejoCredentials?: (remote: { baseUrl: string; repo: string }) => Promise<ForgejoCredentials | undefined>,
  probe: ForgejoProbe = defaultProbe,
): Promise<RepositoryAdapter | null> {
  const origin = originRemote(repoRoot);
  const kind = await resolveCodeRepository(repoRoot, override, probe, origin);
  if (kind === 'github') return githubRepository(repoRoot);
  if (kind === 'gitlab') return gitlabRepository(repoRoot);
  if (kind === 'git') return gitRepository(repoRoot);
  if (kind !== 'forgejo' || !forgejoCredentials) return null;
  const url = await origin();
  const remote = url ? parseForgejoRemote(url) : null;
  const credentials = remote ? await forgejoCredentials(remote) : undefined;
  return remote && credentials ? forgejoRepository({ ...remote, ...credentials }) : null;
}

export type RepositoryResolver = (repoRoot: string, workspace: WorkspaceTrackerSettings) => Promise<RepositoryAdapter | null>;

/** A {@link RepositoryResolver} with no Secret store: Forgejo never resolves. */
export const resolveRepositoryWithoutSecrets: RepositoryResolver = (repoRoot, workspace) =>
  resolveRepositoryAdapter(repoRoot, workspace.codeRepository);

/** The Secret holding the Forgejo token: the Configured Tracker's `tokenSecret` when it is Forgejo on the same host as the remote, else `FORGEJO_TOKEN`. */
function forgejoTokenSecretFor(workspace: WorkspaceTrackerSettings, remoteBaseUrl: string): string {
  const { configured } = workspace;
  if (configured?.kind !== 'forgejo') return FORGEJO_TOKEN_SECRET;
  const settings = forgejoSettingsSchema.safeParse(configured.settings ?? {});
  if (!settings.success || new URL(settings.data.baseUrl).host !== new URL(remoteBaseUrl).host) return FORGEJO_TOKEN_SECRET;
  return settings.data.tokenSecret;
}

/** A {@link RepositoryResolver} whose Forgejo token is read from the Workspace's Secrets. */
export function createRepositoryResolver(secrets: Pick<SecretService, 'reveal'>, http: TrackerHttp = defaultHttp): RepositoryResolver {
  return (repoRoot, workspace) =>
    resolveRepositoryAdapter(repoRoot, workspace.codeRepository, async (remote) => {
      const token = workspace.workspaceId === undefined ? null : await secrets.reveal(workspace.workspaceId, forgejoTokenSecretFor(workspace, remote.baseUrl));
      return token ? { token, http } : undefined;
    });
}

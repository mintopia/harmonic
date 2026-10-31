import { randomBytes } from 'node:crypto';
import { DomainError } from '../domain/errors.js';
import type { GlobalSecretService } from '../secrets/global-secret-service.js';
import { signPass, type RepositoryPass } from './pass.js';
import { repositoryPath } from './server.js';

export const PASS_LIFETIME_MS = 24 * 60 * 60 * 1000;

export type PassSpec = Omit<RepositoryPass, 'expiresAt'>;

export type ProxyKeyCheck = 'agrees' | 'rejected' | 'unreachable';

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_REPOSITORY = 'harmonic-key-check';

export const signingKeySecretName = (targetName: string): string => `${targetName}-proxy-key`;

export class RepositoryPassService {
  constructor(
    private readonly secrets: GlobalSecretService,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(targetName: string, spec: PassSpec): Promise<string> {
    const key = await this.secrets.reveal(signingKeySecretName(targetName));
    if (key === null) throw new DomainError('invalid_state', `Execution Target ${targetName} has no signing key; rotate it to create one`);
    return signPass({ ...spec, expiresAt: this.now() + PASS_LIFETIME_MS }, key);
  }

  /** Replaces the shared key, which revokes every pass signed with the old one. The returned key is the only time it is shown. */
  async rotate(targetName: string): Promise<{ key: string; rotatedAt: number }> {
    const key = randomBytes(32).toString('base64url');
    const { updatedAt } = await this.secrets.set(signingKeySecretName(targetName), key);
    return { key, rotatedAt: updatedAt };
  }

  /** A pass signed with Harmonic's key is rejected as `bad-signature` before the proxy looks at the repository, so the probe never reaches a forge. */
  async checkProxy(targetName: string, proxyUrl: string): Promise<ProxyKeyCheck> {
    const token = await this.issue(targetName, { codeRepository: PROBE_REPOSITORY, baseBranch: 'main', ticketBranch: 'harmonic/task-0' });
    try {
      const res = await fetch(`${proxyUrl.replace(/\/+$/, '')}${repositoryPath(PROBE_REPOSITORY)}/info/refs?service=git-upload-pack`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const body = await res.text();
      return res.status === 403 && body.includes('bad-signature') ? 'rejected' : 'agrees';
    } catch {
      return 'unreachable';
    }
  }
}

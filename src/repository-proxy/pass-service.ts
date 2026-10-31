import { randomBytes } from 'node:crypto';
import { DomainError } from '../domain/errors.js';
import type { SecretService } from '../secrets/secret-service.js';
import { signPass, type RepositoryPass } from './pass.js';

export const PASS_LIFETIME_MS = 24 * 60 * 60 * 1000;

export type PassSpec = Omit<RepositoryPass, 'expiresAt'>;

export interface SigningKeyStatus {
  set: boolean;
  secretName: string;
  lastRotatedAt: number | null;
}

export const signingKeySecretName = (targetName: string): string => `${targetName}-proxy-key`;

export class RepositoryPassService {
  constructor(
    private readonly secrets: SecretService,
    private readonly now: () => number = Date.now,
  ) {}

  async status(workspaceId: number, targetName: string): Promise<SigningKeyStatus> {
    const secretName = signingKeySecretName(targetName);
    const row = (await this.secrets.list(workspaceId)).find((s) => s.name === secretName);
    return { set: row !== undefined, secretName, lastRotatedAt: row?.updatedAt ?? null };
  }

  async issue(workspaceId: number, targetName: string, spec: PassSpec): Promise<string> {
    const secretName = signingKeySecretName(targetName);
    const key = await this.secrets.reveal(workspaceId, secretName);
    if (key === null) throw new DomainError('invalid_state', `Execution Target ${targetName} has no signing key; rotate it to create one`);
    return signPass({ ...spec, expiresAt: this.now() + PASS_LIFETIME_MS }, key);
  }

  /** Replaces the shared key, which revokes every pass signed with the old one. The returned key is the only time it is shown. */
  async rotate(workspaceId: number, targetName: string): Promise<{ key: string }> {
    const key = randomBytes(32).toString('base64url');
    await this.secrets.set(workspaceId, signingKeySecretName(targetName), key);
    return { key };
  }
}

import type { AppConfig, DeepPartial } from '../config.js';

export const SECRET_MASK = '********';

export const S3_SECRET_KEYS = ['accessKeyId', 'secretAccessKey'] as const;
export const WORKSPACE_S3_SECRET_KEYS = ['exportS3AccessKeyId', 'exportS3SecretAccessKey'] as const;

type WorkspaceSecretKey = (typeof WORKSPACE_S3_SECRET_KEYS)[number];

const mask = (value: string | null | undefined): string | null => (value === null || value === undefined ? null : SECRET_MASK);

export function maskConfigSecrets(config: AppConfig): AppConfig {
  const { s3 } = config.export;
  return {
    ...config,
    export: { ...config.export, s3: { ...s3, accessKeyId: mask(s3.accessKeyId), secretAccessKey: mask(s3.secretAccessKey) } },
  };
}

export function maskWorkspaceSecrets<T extends { [K in WorkspaceSecretKey]?: string | null }>(ws: T): T {
  return { ...ws, exportS3AccessKeyId: mask(ws.exportS3AccessKeyId), exportS3SecretAccessKey: mask(ws.exportS3SecretAccessKey) };
}

/** A masked secret written back by a client keeps the stored value; null clears, anything else replaces. */
export function restoreConfigSecrets<T extends DeepPartial<AppConfig>>(incoming: T, current: AppConfig): T {
  const s3 = incoming.export?.s3;
  if (!s3) return incoming;
  const restored = { ...s3 };
  for (const key of S3_SECRET_KEYS) {
    if (restored[key] === SECRET_MASK) restored[key] = current.export.s3[key];
  }
  return { ...incoming, export: { ...incoming.export, s3: restored } };
}

export function isMaskedWorkspaceSecret(key: string, value: unknown): boolean {
  return value === SECRET_MASK && (WORKSPACE_S3_SECRET_KEYS as readonly string[]).includes(key);
}

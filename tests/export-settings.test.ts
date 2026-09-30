import { describe, expect, it } from 'vitest';
import { resolveExportSettings } from '../src/archive/export-settings.js';
import { appConfigSchema, baselineConfig, mergeConfig } from '../src/config.js';
import { workspaceOverridesSchema } from '../src/domain/workspaces.js';

const withExport = (enabled: boolean, path: string | null) =>
  mergeConfig(baselineConfig(), { export: { enabled, directory: { path } } });

describe('resolveExportSettings', () => {
  it('baseline has export disabled with no directory', () => {
    const cfg = appConfigSchema.parse(baselineConfig());
    expect(resolveExportSettings(cfg, undefined)).toEqual({
      enabled: false,
      includeStates: ['done', 'cancelled', 'deleted'],
      directoryPath: null,
      s3: null,
    });
  });

  it('inherits global values when the Workspace values are null', () => {
    const r = resolveExportSettings(withExport(true, '/srv/x'), { exportEnabled: null, exportDirectoryPath: null });
    expect(r.enabled).toBe(true);
    expect(r.directoryPath).toBe('/srv/x');
  });

  it('Workspace values win, including an explicit false', () => {
    const r = resolveExportSettings(withExport(true, '/srv/x'), { exportEnabled: false, exportDirectoryPath: '/srv/y' });
    expect(r.enabled).toBe(false);
    expect(r.directoryPath).toBe('/srv/y');
  });
});

describe('resolveExportSettings s3', () => {
  const s3Global = (s3: Record<string, unknown>) => mergeConfig(baselineConfig(), { export: { s3 } } as never);

  it('is null when no bucket resolves', () => {
    expect(resolveExportSettings(s3Global({ region: 'eu-west-2' }), undefined).s3).toBeNull();
  });

  it('a Workspace bucket override enables S3 and wins per key', () => {
    const cfg = s3Global({ bucket: 'global', region: 'eu-west-2', prefix: 'g/' });
    expect(resolveExportSettings(cfg, { exportS3Bucket: 'ws' }).s3).toMatchObject({ bucket: 'ws', region: 'eu-west-2', prefix: 'g/' });
    expect(resolveExportSettings(s3Global({}), { exportS3Bucket: 'ws' }).s3?.bucket).toBe('ws');
  });

  it('uses explicit credentials only when both keys resolve', () => {
    const cfg = s3Global({ bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK' });
    expect(resolveExportSettings(cfg, undefined).s3?.credentials).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK' });
    expect(resolveExportSettings(s3Global({ bucket: 'b', accessKeyId: 'AK' }), undefined).s3?.credentials).toBeNull();
    expect(resolveExportSettings(s3Global({ bucket: 'b' }), { exportS3SecretAccessKey: 'SK' }).s3?.credentials).toBeNull();
  });

  it('resolves the key pair as a unit, never mixing Workspace and global keys', () => {
    const cfg = s3Global({ bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK' });
    expect(resolveExportSettings(cfg, { exportS3SecretAccessKey: 'WSK' }).s3?.credentials).toBeNull();
    expect(resolveExportSettings(cfg, { exportS3AccessKeyId: 'WAK', exportS3SecretAccessKey: 'WSK' }).s3?.credentials).toEqual({
      accessKeyId: 'WAK',
      secretAccessKey: 'WSK',
    });
    expect(resolveExportSettings(cfg, { exportS3AccessKeyId: null, exportS3SecretAccessKey: null }).s3?.credentials).toEqual({
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
    });
  });

  it('rejects an endpoint carrying credentials in the URL', () => {
    expect(workspaceOverridesSchema.safeParse({ exportS3Endpoint: 'https://user:pw@minio.local' }).success).toBe(false);
    const cfg = baselineConfig();
    cfg.export.s3.endpoint = 'https://user:pw@minio.local';
    expect(appConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('validates the Workspace endpoint override as a URL', () => {
    expect(workspaceOverridesSchema.safeParse({ exportS3Endpoint: 'not a url' }).success).toBe(false);
    expect(workspaceOverridesSchema.safeParse({ exportS3Endpoint: 'https://minio.local:9000' }).success).toBe(true);
  });
});

describe('export path validation', () => {
  it('rejects a relative global path', () => {
    const cfg = baselineConfig();
    cfg.export.directory.path = 'relative/dir';
    expect(appConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('accepts an absolute global path', () => {
    expect(appConfigSchema.safeParse(withExport(true, '/abs/dir')).success).toBe(true);
  });

  it('rejects a relative Workspace override', () => {
    expect(workspaceOverridesSchema.safeParse({ exportDirectoryPath: 'rel' }).success).toBe(false);
    expect(workspaceOverridesSchema.safeParse({ exportDirectoryPath: '/abs' }).success).toBe(true);
  });
});

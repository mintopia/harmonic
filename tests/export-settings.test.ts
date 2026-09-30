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

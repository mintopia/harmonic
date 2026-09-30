import { describe, expect, it } from 'vitest';
import { resolveExportSettings } from '../src/archive/export-settings.js';
import { BASELINE_REDACT_PATTERNS } from '../src/archive/redact.js';
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
      redactPatterns: BASELINE_REDACT_PATTERNS,
    });
  });

  it('adds global then Workspace redaction patterns after the baseline set', () => {
    const global = mergeConfig(baselineConfig(), { export: { redact: { patterns: [{ id: 'global-one', regex: 'g1' }] } } });
    const r = resolveExportSettings(global, {
      exportEnabled: null,
      exportDirectoryPath: null,
      exportRedactPatterns: JSON.stringify([{ id: 'internal-host', regex: 'corp\\.example\\.internal' }]),
    });
    expect(r.redactPatterns.map((p) => p.id)).toEqual([...BASELINE_REDACT_PATTERNS.map((p) => p.id), 'global-one', 'internal-host']);
  });

  it('inherits global values when the Workspace values are null', () => {
    const r = resolveExportSettings(withExport(true, '/srv/x'), { exportEnabled: null, exportDirectoryPath: null, exportRedactPatterns: null });
    expect(r.enabled).toBe(true);
    expect(r.directoryPath).toBe('/srv/x');
  });

  it('Workspace values win, including an explicit false', () => {
    const r = resolveExportSettings(withExport(true, '/srv/x'), { exportEnabled: false, exportDirectoryPath: '/srv/y', exportRedactPatterns: null });
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

describe('redaction pattern validation', () => {
  const withPatterns = (patterns: { id: string; regex: string }[]) =>
    ({ ...baselineConfig(), export: { ...baselineConfig().export, redact: { patterns } } });

  it('accepts a valid global pattern', () => {
    expect(appConfigSchema.safeParse(withPatterns([{ id: 'internal-host', regex: 'corp\\.example\\.internal' }])).success).toBe(true);
  });

  it('rejects an invalid global regex', () => {
    expect(appConfigSchema.safeParse(withPatterns([{ id: 'bad', regex: '(' }])).success).toBe(false);
  });

  it('rejects a global id with uppercase or spaces', () => {
    expect(appConfigSchema.safeParse(withPatterns([{ id: 'Bad Id', regex: 'x' }])).success).toBe(false);
    expect(appConfigSchema.safeParse(withPatterns([{ id: 'has space', regex: 'x' }])).success).toBe(false);
  });

  it('validates Workspace override patterns', () => {
    expect(workspaceOverridesSchema.safeParse({ exportRedactPatterns: [{ id: 'internal-host', regex: 'corp\\.example\\.internal' }] }).success).toBe(true);
    expect(workspaceOverridesSchema.safeParse({ exportRedactPatterns: [{ id: 'internal-host', regex: '(' }] }).success).toBe(false);
    expect(workspaceOverridesSchema.safeParse({ exportRedactPatterns: null }).success).toBe(true);
  });
});

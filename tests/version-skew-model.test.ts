import { describe, expect, it } from 'vitest';
import { versionSkew } from '../web/src/version-skew-model.js';

describe('versionSkew', () => {
  it('asks for a service restart when the installed bundle is newer than the running server', () => {
    expect(versionSkew('2.25.0', '2.21.0')).toEqual({ kind: 'restart-service', bundleVersion: '2.25.0', runningVersion: '2.21.0' });
  });

  it('asks for a page reload when the server was upgraded under an open tab', () => {
    expect(versionSkew('2.24.0', '2.25.0')).toEqual({ kind: 'reload-page', bundleVersion: '2.24.0', runningVersion: '2.25.0' });
  });

  it('reports nothing when the versions match, or either side is unknown or not a stable release', () => {
    expect(versionSkew('2.25.0', '2.25.0')).toBeNull();
    expect(versionSkew(null, '2.25.0')).toBeNull();
    expect(versionSkew('2.25.0', null)).toBeNull();
    expect(versionSkew('2.26.0-beta.1', '2.25.0')).toBeNull();
  });
});

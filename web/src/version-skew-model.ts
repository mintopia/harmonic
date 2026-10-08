import { compareStableVersions } from '../../src/domain/stable-version.js';

/** The served web bundle and the running server disagree on version:
 * `restart-service` when the package on disk was upgraded but the old process
 * still runs, `reload-page` when the server was upgraded under an open tab. */
export type VersionSkew = {
  kind: 'restart-service' | 'reload-page';
  bundleVersion: string;
  runningVersion: string;
};

export function versionSkew(bundleVersion: string | null, runningVersion: string | null): VersionSkew | null {
  if (bundleVersion === null || runningVersion === null) return null;
  const order = compareStableVersions(bundleVersion, runningVersion);
  if (order === null || order === 0) return null;
  return { kind: order > 0 ? 'restart-service' : 'reload-page', bundleVersion, runningVersion };
}

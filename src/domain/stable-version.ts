const stableVersion = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type StableVersion = readonly [string, string, string];

function parseStableVersion(version: string): StableVersion | null {
  const match = stableVersion.exec(version);
  if (match === null) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return [major, minor, patch];
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

/** Returns null unless both inputs name stable semantic versions. */
export function compareStableVersions(left: string, right: string): number | null {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  if (leftParts === null || rightParts === null) return null;

  const [leftMajor, leftMinor, leftPatch] = leftParts;
  const [rightMajor, rightMinor, rightPatch] = rightParts;
  for (const difference of [
    compareNumericIdentifiers(leftMajor, rightMajor),
    compareNumericIdentifiers(leftMinor, rightMinor),
    compareNumericIdentifiers(leftPatch, rightPatch),
  ]) {
    if (difference !== 0) return difference;
  }
  return 0;
}

export function parseWorkflowRef(ref: string): { name: string; version: number | null } {
  const at = ref.lastIndexOf('@');
  if (at < 0) return { name: ref, version: null };
  const version = Number(ref.slice(at + 1));
  return { name: ref.slice(0, at), version: Number.isInteger(version) ? version : null };
}

export function newerVersion(ref: string, latestVersion: number | null | undefined): number | null {
  const { version } = parseWorkflowRef(ref);
  return version !== null && latestVersion != null && latestVersion > version ? latestVersion : null;
}

export function snapshotNote(ref: string, latestVersion: number | null | undefined): string | null {
  const newer = newerVersion(ref, latestVersion);
  const { version } = parseWorkflowRef(ref);
  return newer === null ? null : `Snapshotted v${version}; v${newer} exists and applies from the next Retry.`;
}

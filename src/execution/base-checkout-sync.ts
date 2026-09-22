import { randomBytes } from 'node:crypto';
import { mkdtemp, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Git } from './git.js';
import { forEachYielding } from '../reliability/yield.js';

export interface BaseCheckoutSyncResult {
  mergedPaths: string[];
  keptPaths: string[];
}

const REGULAR_FILE_MODES = new Set(['100644', '100755']);

/** Snapshot the operator's dirty paths in a base checkout. Must be called
 * BEFORE the branch ref moves — see the call site in merge-policy.ts. */
export function captureDirtyPaths(checkoutDir: string): Promise<Set<string>> {
  return Git.dirtyPathsSnapshot(checkoutDir);
}

async function resolveOverlapPath(
  checkoutDir: string,
  getTmpDir: () => Promise<string>,
  oldTip: string,
  newTip: string,
  path: string,
  mergedPaths: string[],
  keptPaths: string[],
): Promise<void> {
  const absPath = join(checkoutDir, path);
  const base = await Git.lsTreeEntry(checkoutDir, oldTip, path);
  const theirs = await Git.lsTreeEntry(checkoutDir, newTip, path);
  const oursStat = await lstat(absPath).catch(() => null);
  const oursIsRegular = oursStat !== null && oursStat.isFile();

  if (theirs === null) {
    keptPaths.push(path);
    await Git.removeIndexEntry(checkoutDir, path);
    return;
  }

  if (oursIsRegular) {
    const oursBytes = await readFile(absPath);
    const theirsBytes = await Git.blobBytes(checkoutDir, theirs.oid);
    if (oursBytes.equals(theirsBytes)) {
      await Git.setIndexBlob(checkoutDir, path, theirs.mode, theirs.oid);
      return;
    }

    const baseIsRegular = base !== null && REGULAR_FILE_MODES.has(base.mode);
    if (baseIsRegular && REGULAR_FILE_MODES.has(theirs.mode)) {
      const dir = await getTmpDir();
      const baseTmp = join(dir, `${randomBytes(8).toString('hex')}-base`);
      const theirsTmp = join(dir, `${randomBytes(8).toString('hex')}-theirs`);
      const baseBytes = base ? await Git.blobBytes(checkoutDir, base.oid) : Buffer.alloc(0);
      await writeFile(baseTmp, baseBytes);
      await writeFile(theirsTmp, theirsBytes);
      const result = await Git.mergeFileResult(absPath, baseTmp, theirsTmp);
      if (result.ok) {
        const targetTmp = join(dirname(absPath), `.harmonic-sync-${randomBytes(8).toString('hex')}`);
        await writeFile(targetTmp, result.content, { mode: oursStat!.mode & 0o777 });
        await rename(targetTmp, absPath);
        await Git.setIndexBlob(checkoutDir, path, theirs.mode, theirs.oid);
        mergedPaths.push(path);
        return;
      }
    }
  }

  keptPaths.push(path);
  await Git.setIndexBlob(checkoutDir, path, theirs.mode, theirs.oid);
}

/**
 * Bring a base checkout's index and working tree from `oldTip` to `newTip`
 * without clobbering or blocking on the operator's uncommitted work. Paths
 * the operator did not touch are synced outright; paths both sides touched
 * are combined with a 3-way text merge where possible, and otherwise left on
 * disk exactly as the operator has them (their bytes never overwritten),
 * with only the index entry advanced to `newTip` so `git status` reads as an
 * unstaged diff against the new HEAD rather than a staged reversal of the
 * merge. Never moves HEAD's branch, writes conflict markers, or touches
 * paths the operator dirtied that the merge did not change.
 */
export async function syncBaseCheckout(
  checkoutDir: string,
  dirtyPaths: Set<string>,
  oldTip: string,
  newTip: string,
): Promise<BaseCheckoutSyncResult> {
  const changed = await Git.changedPaths(checkoutDir, oldTip, newTip);
  const safeUpsert: string[] = [];
  const safeDelete: string[] = [];
  const overlap: string[] = [];

  await forEachYielding(changed, async (entry) => {
    if (dirtyPaths.has(entry.path)) {
      overlap.push(entry.path);
      return;
    }
    if (entry.status === 'A' && (await Git.pathExists(join(checkoutDir, entry.path)))) {
      overlap.push(entry.path);
      return;
    }
    if (entry.status === 'D') safeDelete.push(entry.path);
    else safeUpsert.push(entry.path);
  });

  await Git.checkoutPathsFromRev(checkoutDir, newTip, safeUpsert);
  await Git.removePaths(checkoutDir, safeDelete);

  const mergedPaths: string[] = [];
  const keptPaths: string[] = [];
  let tmp: string | undefined;
  const getTmpDir = async (): Promise<string> => {
    if (!tmp) tmp = await mkdtemp(join(tmpdir(), 'harmonic-checkout-sync-'));
    return tmp;
  };

  try {
    await forEachYielding(overlap, (path) => resolveOverlapPath(checkoutDir, getTmpDir, oldTip, newTip, path, mergedPaths, keptPaths));
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }

  return { mergedPaths, keptPaths };
}

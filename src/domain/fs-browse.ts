import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { z } from 'zod';
import { DomainError } from './errors.js';

/** One immediate child directory of the browsed path. */
export const fsEntrySchema = z
  .object({
    name: z.string().meta({ example: 'harmonic' }),
    /** Absolute path — feed straight back as `?path=` to descend into it. */
    path: z.string().meta({ example: '/home/dev/harmonic' }),
  })
  .meta({ id: 'FsEntry' });

/** The immediate child directories of one path, for the lazy directory picker. */
export const fsListingSchema = z
  .object({
    /** The absolute path that was browsed (the resolved home when none was given). */
    path: z.string().meta({ example: '/home/dev' }),
    /** The parent directory's absolute path, or `null` at the filesystem root. */
    parent: z.string().nullable().meta({ example: '/home' }),
    entries: z.array(fsEntrySchema),
  })
  .meta({ id: 'FsListing' });

export type FsListing = z.infer<typeof fsListingSchema>;

/**
 * List the immediate child directories of `inputPath`, one level deep — the
 * data behind the workspace directory picker (issue #62). An empty or omitted
 * path starts at the server user's home. Files and hidden (dot) directories are
 * excluded; entries are sorted by name. There is deliberately no root
 * restriction (a sysadmin concern, per the map decision): any directory the
 * running user can read is browsable.
 *
 * Throws a `DomainError` the route turns into a status: `not_found` (404) for a
 * missing path, `validation` (400) for a non-directory or a permission-denied
 * path.
 */
export async function browseDirectory(inputPath?: string): Promise<FsListing> {
  const target = inputPath && inputPath.length > 0 ? resolve(inputPath) : homedir();

  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new DomainError('not_found', `path does not exist: ${target}`);
    if (code === 'ENOTDIR') throw new DomainError('validation', `not a directory: ${target}`);
    if (code === 'EACCES' || code === 'EPERM')
      throw new DomainError('validation', `permission denied: ${target}`);
    throw err;
  }

  const entries = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: join(target, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = dirname(target);
  return { path: target, parent: parent === target ? null : parent, entries };
}

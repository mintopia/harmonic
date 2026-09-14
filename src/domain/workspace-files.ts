import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { DomainError } from './errors.js';

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 100;

export const workspaceFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['directory', 'file']),
  size: z.number().int().nonnegative(),
});

export const workspaceFileListingSchema = z.object({
  path: z.string(),
  entries: z.array(workspaceFileEntrySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const workspaceFileSchema = z.object({
  text: z.string().nullable(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  isBinary: z.boolean(),
});

export type WorkspaceFileListing = z.infer<typeof workspaceFileListingSchema>;
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

function validation(message: string): never {
  throw new DomainError('validation', message);
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function workspacePath(root: string, path: string): Promise<{ root: string; target: string }> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) validation('path must stay within the workspace');
  const resolvedRoot = await realpath(root);
  const lexicalTarget = resolve(resolvedRoot, path);
  if (!inside(resolvedRoot, lexicalTarget)) validation('path must stay within the workspace');
  try {
    const target = await realpath(lexicalTarget);
    if (!inside(resolvedRoot, target)) validation('path must stay within the workspace');
    return { root: resolvedRoot, target };
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') throw new DomainError('not_found', `path does not exist: ${path}`);
    throw err;
  }
}

function pathFrom(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}

function mimeFor(path: string, binary: boolean): string {
  if (binary) return 'application/octet-stream';
  const extension = extname(path).toLowerCase();
  const mimes: Record<string, string> = {
    '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.md': 'text/markdown',
    '.mjs': 'text/javascript', '.js': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/tsx',
    '.yaml': 'text/yaml', '.yml': 'text/yaml', '.xml': 'application/xml', '.sh': 'text/x-shellscript',
  };
  return mimes[extension] ?? 'text/plain';
}

export async function listWorkspaceFiles({ root, path = '', limit = DEFAULT_PAGE_SIZE, offset = 0 }: {
  root: string;
  path?: string;
  limit?: number;
  offset?: number;
}): Promise<WorkspaceFileListing> {
  const pageSize = Math.min(limit, MAX_PAGE_SIZE);
  const location = await workspacePath(root, path);
  const targetStat = await stat(location.target);
  if (!targetStat.isDirectory()) validation('path is not a directory');
  const dirents = await readdir(location.target, { withFileTypes: true });
  const entries: Array<z.infer<typeof workspaceFileEntrySchema> | null> = [];
  for (const dirent of dirents) {
    const candidate = resolve(location.target, dirent.name);
    try {
      const resolved = await realpath(candidate);
      if (!inside(location.root, resolved)) {
        entries.push(null);
        continue;
      }
      const info = await stat(resolved);
      entries.push(info.isDirectory() || info.isFile()
        ? { name: dirent.name, path: pathFrom(location.root, candidate), type: info.isDirectory() ? 'directory' : 'file', size: info.size }
        : null);
    } catch {
      entries.push(null);
    }
  }
  const visible = entries.filter((entry): entry is z.infer<typeof workspaceFileEntrySchema> => entry !== null)
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { path: pathFrom(location.root, location.target), entries: visible.slice(offset, offset + pageSize), total: visible.length, limit: pageSize, offset };
}

export async function readWorkspaceFile({ root, path }: { root: string; path: string }): Promise<WorkspaceFile> {
  const location = await workspacePath(root, path);
  const info = await stat(location.target);
  if (!info.isFile()) validation('path is not a file');
  const contents = await readFile(location.target);
  let text: string | null = null;
  if (!contents.includes(0)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    } catch {
    }
  }
  const isBinary = text === null;
  return { text, mime: mimeFor(location.target, isBinary), size: info.size, isBinary };
}

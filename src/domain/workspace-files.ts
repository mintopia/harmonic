import { constants, createReadStream } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
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
  excluded: z.boolean(),
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
  isTooLarge: z.boolean(),
});

export const workspaceFileWriteSchema = z.object({ text: z.string() });

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

function mimeFor(path: string, binary = false): string {
  const extension = extname(path).toLowerCase();
  const mimes: Record<string, string> = {
    '.aac': 'audio/aac', '.flac': 'audio/flac', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
    '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.wav': 'audio/wav', '.webm': 'audio/webm', '.webp': 'image/webp',
    '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.markdown': 'text/markdown', '.md': 'text/markdown',
    '.mjs': 'text/javascript', '.js': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/tsx',
    '.yaml': 'text/yaml', '.yml': 'text/yaml', '.xml': 'application/xml', '.sh': 'text/x-shellscript',
  };
  return mimes[extension] ?? (binary ? 'application/octet-stream' : 'text/plain');
}

async function workspaceRegularFile(root: string, path: string): Promise<{ target: string; size: number; mime: string }> {
  const location = await workspacePath(root, path);
  const info = await stat(location.target);
  if (!info.isFile()) validation('path is not a file');
  return { target: location.target, size: info.size, mime: mimeFor(location.target) };
}

export async function listWorkspaceFiles({ root, path = '', excludedDirectories = [], limit = DEFAULT_PAGE_SIZE, offset = 0 }: {
  root: string;
  path?: string;
  excludedDirectories?: readonly string[];
  limit?: number;
  offset?: number;
}): Promise<WorkspaceFileListing> {
  const pageSize = Math.min(limit, MAX_PAGE_SIZE);
  const location = await workspacePath(root, path);
  const targetStat = await stat(location.target);
  if (!targetStat.isDirectory()) validation('path is not a directory');
  if (excludedDirectories.includes(pathFrom(location.root, location.target))) {
    return { path: pathFrom(location.root, location.target), entries: [], total: 0, limit: pageSize, offset };
  }
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
      const entryPath = pathFrom(location.root, candidate);
      entries.push(info.isDirectory() || info.isFile()
        ? { name: dirent.name, path: entryPath, type: info.isDirectory() ? 'directory' : 'file', size: info.size, excluded: info.isDirectory() && excludedDirectories.includes(entryPath) }
        : null);
    } catch {
      entries.push(null);
    }
  }
  const visible = entries.filter((entry): entry is z.infer<typeof workspaceFileEntrySchema> => entry !== null)
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { path: pathFrom(location.root, location.target), entries: visible.slice(offset, offset + pageSize), total: visible.length, limit: pageSize, offset };
}

export async function readWorkspaceFile({ root, path, maxBytes = Number.MAX_SAFE_INTEGER }: { root: string; path: string; maxBytes?: number }): Promise<WorkspaceFile> {
  const file = await workspaceRegularFile(root, path);
  if (file.size > maxBytes) return { text: null, mime: file.mime, size: file.size, isBinary: false, isTooLarge: true };
  const contents = await readFile(file.target);
  let text: string | null = null;
  if (!contents.includes(0)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    } catch {
    }
  }
  const isBinary = text === null;
  return { text, mime: mimeFor(file.target, isBinary), size: file.size, isBinary, isTooLarge: false };
}

export async function streamWorkspaceFile({ root, path }: { root: string; path: string }): Promise<{ stream: ReturnType<typeof createReadStream>; mime: string; size: number }> {
  const file = await workspaceRegularFile(root, path);
  return { stream: createReadStream(file.target), mime: file.mime, size: file.size };
}

export async function writeWorkspaceFile({ root, path, text }: { root: string; path: string; text: string }): Promise<WorkspaceFile> {
  const location = await workspacePath(root, path);
  if (!(await stat(location.target)).isFile()) validation('path is not a file');
  try {
    const handle = await open(location.target, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const openedTarget = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!inside(location.root, openedTarget)) validation('path must stay within the workspace');
      if (!(await handle.stat()).isFile()) validation('path is not a file');
      await handle.truncate();
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? err.code : undefined;
    if (code === 'ELOOP') validation('path must stay within the workspace');
    throw err;
  }
  return readWorkspaceFile({ root, path });
}

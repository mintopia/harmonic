import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { GitError } from './errors.js';

const execFileAsync = promisify(execFile);

export const gitStatusCodeSchema = z.enum(['.', 'M', 'T', 'A', 'D', 'R', 'C', 'U', '?']);

export const gitStatusEntrySchema = z.object({
  path: z.string(),
  indexStatus: gitStatusCodeSchema,
  worktreeStatus: gitStatusCodeSchema,
});
export type GitStatusEntry = z.infer<typeof gitStatusEntrySchema>;

export const gitStatusSchema = z.object({
  entries: z.array(gitStatusEntrySchema),
});

export type GitStatus = z.infer<typeof gitStatusSchema>;
type GitStatusCode = z.infer<typeof gitStatusCodeSchema>;

function statusCode(value: string | undefined): GitStatusCode {
  return gitStatusCodeSchema.parse(value ?? '.');
}

function pathAfterFields(record: string, fields: number): string {
  let offset = 0;
  for (let count = 0; count < fields; count += 1) {
    const separator = record.indexOf(' ', offset);
    if (separator < 0) return '';
    offset = separator + 1;
  }
  return record.slice(offset);
}

export function parseGitStatus(output: string): GitStatus {
  const entries: GitStatus['entries'] = [];
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('1 ')) {
      entries.push({ path: pathAfterFields(record, 8), indexStatus: statusCode(record[2]), worktreeStatus: statusCode(record[3]) });
      continue;
    }
    if (record.startsWith('2 ')) {
      entries.push({ path: pathAfterFields(record, 9), indexStatus: statusCode(record[2]), worktreeStatus: statusCode(record[3]) });
      index += 1;
      continue;
    }
    if (record.startsWith('u ')) {
      entries.push({ path: pathAfterFields(record, 10), indexStatus: statusCode(record[2]), worktreeStatus: statusCode(record[3]) });
      continue;
    }
    if (record.startsWith('? ')) entries.push({ path: record.slice(2), indexStatus: '?', worktreeStatus: '?' });
  }
  return { entries };
}

export async function readGitStatus(root: string): Promise<GitStatus> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--porcelain=v2', '-z'], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      killSignal: 'SIGKILL',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return parseGitStatus(stdout);
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new GitError(`git status failed: ${detail || message}`, detail);
  }
}

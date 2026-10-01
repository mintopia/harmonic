import type { AttemptRow } from '../db/schema.js';

export interface AttemptGitProvenance {
  id: number;
  startCommit: string | null;
  endCommit: string | null;
}

export interface GitProvenance {
  remoteUrl: string | null;
  baseBranch: string | null;
  startCommit: string | null;
  endCommit: string | null;
  mergeCommit: string | null;
  attempts: AttemptGitProvenance[];
}

export type ProvenanceAttempt = Pick<AttemptRow, 'id' | 'number' | 'baseBranch' | 'startOid' | 'diffBaseOid' | 'diffHeadOid' | 'verifiedHeadOid'>;

export function emptyGitProvenance(): GitProvenance {
  return { remoteUrl: null, baseBranch: null, startCommit: null, endCommit: null, mergeCommit: null, attempts: [] };
}

const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i;

/** Drops `user:token@` from URL-style remotes; scp-style `git@host:path` carries no secret and is left as-is. */
export function stripRemoteCredentials(url: string | null): string | null {
  if (url === null) return null;
  const trimmed = url.trim();
  return trimmed === '' ? null : trimmed.replace(URL_USERINFO, '$1');
}

function mergeOidOf(fact: unknown): string | null {
  if (typeof fact !== 'object' || fact === null) return null;
  const { event, oid } = fact as { event?: unknown; oid?: unknown };
  return event === 'merged' && typeof oid === 'string' && oid !== '' ? oid : null;
}

export function computeGitProvenance(input: {
  attempts: readonly ProvenanceAttempt[];
  facts: readonly unknown[];
  remoteUrl: string | null;
  taskBaseBranch?: string | null;
  currentBranch?: string | null;
}): GitProvenance {
  const ordered = [...input.attempts].sort((a, b) => a.number - b.number);
  const perAttempt = ordered.map((a) => ({
    id: a.id,
    startCommit: a.startOid ?? a.diffBaseOid ?? null,
    endCommit: a.diffHeadOid ?? a.verifiedHeadOid ?? null,
  }));
  let mergeCommit: string | null = null;
  for (const fact of input.facts) mergeCommit = mergeOidOf(fact) ?? mergeCommit;
  const first = perAttempt[0];
  const lastEnd = [...perAttempt].reverse().find((a) => a.endCommit !== null)?.endCommit ?? null;
  return {
    remoteUrl: stripRemoteCredentials(input.remoteUrl),
    baseBranch: [...ordered].reverse().find((a) => a.baseBranch)?.baseBranch || input.taskBaseBranch || input.currentBranch || null,
    startCommit: first?.startCommit ?? null,
    endCommit: mergeCommit ?? lastEnd,
    mergeCommit,
    attempts: perAttempt,
  };
}

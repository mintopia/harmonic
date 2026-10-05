/** The open-PR Merge Fate's inputs. */
export interface OpenPRInput {
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export type RepositoryVerifyResult = { ok: true } | { ok: false; reason: string };

/** The Code Repository seam: where branches and PRs live, independent of where tickets live. */
export interface RepositoryAdapter {
  readonly kind: string;
  /** Opens the PR/MR and returns its web URL; null when this kind opens none (it only pushes the branch). */
  openPR(input: OpenPRInput): Promise<string | null>;
  /** Checks the repository is reachable with the ambient credentials. */
  verify(): Promise<RepositoryVerifyResult>;
}

/** The http(s) URL a hosting CLI printed for the PR/MR it created (its last such line), or null when none is present. */
export function pullRequestUrlFromOutput(stdout: string): string | null {
  for (const line of stdout.split('\n').reverse()) {
    const candidate = line.trim();
    if (candidate === '' || /\s/.test(candidate)) continue;
    const url = parseWebUrl(candidate);
    if (url !== null) return url;
  }
  return null;
}

/** The input as a normalised http(s) URL, or null when it is not one. */
export function parseWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

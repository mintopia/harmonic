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
  openPR(input: OpenPRInput): Promise<void>;
  /** Checks the repository is reachable with the ambient credentials. */
  verify(): Promise<RepositoryVerifyResult>;
}

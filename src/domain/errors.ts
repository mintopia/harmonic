export type DomainErrorCode = 'not_found' | 'invalid_state' | 'validation' | 'conflict' | 'forbidden' | 'not_packaged' | 'rate_limited';

const HTTP_STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  invalid_state: 409,
  conflict: 409,
  validation: 400,
  forbidden: 403,
  not_packaged: 409,
  rate_limited: 429,
};

export interface ErrorIssue {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly issues?: readonly ErrorIssue[],
  ) {
    super(message);
    this.name = 'DomainError';
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

/** Thrown by the git primitive (`execution/git.ts`). */
export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

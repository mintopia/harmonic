export type DomainErrorCode = 'not_found' | 'invalid_state' | 'validation' | 'conflict' | 'forbidden';

const HTTP_STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  invalid_state: 409,
  conflict: 409,
  validation: 400,
  forbidden: 403,
};

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
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

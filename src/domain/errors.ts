export type DomainErrorCode = 'not_found' | 'invalid_state' | 'validation' | 'conflict';

const HTTP_STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  invalid_state: 409,
  conflict: 409,
  validation: 400,
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

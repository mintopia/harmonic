import { DomainError } from '../domain/errors.js';

export const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

/** Wraps a tool body: JSON-encodes its result and turns a DomainError into an MCP error result. */
export const wrapAsync = <A, R>(fn: (args: A) => Promise<R>) => {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (err) {
      if (err instanceof DomainError) {
        return {
          content: [{ type: 'text' as const, text: `Error (${err.code}): ${err.message}` }],
          isError: true,
        };
      }
      throw err;
    }
  };
};

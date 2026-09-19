export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

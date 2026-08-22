/**
 * Pure prompt-template primitives (issue #33) with **zero** server/browser
 * dependencies, so both the server (`drive-prompt.ts`, the critic) and the web
 * settings preview can import them without dragging in `TaskRow`/drizzle or any
 * node built-in. Keep this module dependency-free.
 */

/** The five interpolation tokens a Drive-style prompt fills. */
export interface DriveFields {
  skill: string;
  ref: string;
  url: string;
  title: string;
  body: string;
}

/** Fill a Drive Prompt template's `{skill}/{ref}/{url}/{title}/{body}` placeholders. */
export function buildDrivePrompt(template: string, fields: DriveFields): string {
  return template.replace(/\{(skill|ref|url|title|body)\}/g, (_, key: keyof DriveFields) => fields[key]);
}

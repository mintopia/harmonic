import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('TrackerPollerManager boundary', () => {
  it('keeps Epic execution dependencies behind EpicService', async () => {
    const source = await readFile(new URL('../src/tracker/manager.ts', import.meta.url), 'utf8');

    expect(source).not.toContain("../execution/git.js");
    expect(source).not.toContain("../execution/epic-");
    expect(source).toContain("./epic-service.js");
  });
});

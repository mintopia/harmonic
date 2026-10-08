import { describe, expect, it } from 'vitest';
import { displayPath, looksLikePath } from '../web/src/path.js';

describe('looksLikePath', () => {
  it('accepts absolute, home and dot-relative paths only', () => {
    expect(looksLikePath('/a/b')).toBe(true);
    expect(looksLikePath('~/a')).toBe(true);
    expect(looksLikePath('./a')).toBe(true);
    expect(looksLikePath('src/app.ts')).toBe(false);
    expect(looksLikePath('npm test')).toBe(false);
    expect(looksLikePath('/ foo')).toBe(false);
  });
});

describe('displayPath', () => {
  it('is relative to the base directory when inside it', () => {
    expect(displayPath('/work/repo/src/a.ts', '/work/repo/')).toBe('src/a.ts');
  });

  it('collapses a home directory prefix', () => {
    expect(displayPath('/home/workspace/.npm/x/y.json')).toBe('~/.npm/x/y.json');
    expect(displayPath('/Users/jess/p/a.ts')).toBe('~/p/a.ts');
  });

  it('leaves other paths and non-paths alone', () => {
    expect(displayPath('/opt/x/a.ts', '/work')).toBe('/opt/x/a.ts');
    expect(displayPath('/workrepo/a.ts', '/work')).toBe('/workrepo/a.ts');
    expect(displayPath('grep foo')).toBe('grep foo');
  });
});

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { highlightCode } from '../web/src/syntax.js';

describe('highlightCode', () => {
  it('highlights known languages', () => {
    const html = highlightCode('const answer: number = 42;', 'ts');
    expect(html).toContain('hljs-keyword');
  });

  it('falls back to auto-detection for an unknown/absent language', () => {
    const html = highlightCode('function f() { return 1; }');
    expect(html.length).toBeGreaterThan(0);
  });

  it('sanitizes output: no injected script tags or live event handlers survive', () => {
    const imgHtml = highlightCode('<img src=x onerror=alert(1)>');
    const imgContainer = document.createElement('div');
    imgContainer.innerHTML = imgHtml;
    expect(imgContainer.querySelector('img')).toBeNull();
    expect(imgContainer.querySelector('[onerror]')).toBeNull();

    const scriptHtml = highlightCode('<script>alert(1)</script>');
    expect(scriptHtml).not.toContain('<script>');
    const scriptContainer = document.createElement('div');
    scriptContainer.innerHTML = scriptHtml;
    expect(scriptContainer.querySelector('script')).toBeNull();
  });
});

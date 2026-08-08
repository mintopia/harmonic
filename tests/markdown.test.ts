// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../web/src/markdown.js';

describe('renderMarkdown', () => {
  it('renders common Markdown to HTML', () => {
    const html = renderMarkdown('# H\n\nSome **bold** and `code` and a [link](https://x.com).\n\n- a\n- b');
    expect(html).toContain('<h1>H</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('href="https://x.com"');
  });

  it('opens links in a new tab safely', () => {
    const html = renderMarkdown('[x](https://x.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('strips XSS: inline handlers, scripts, and javascript: hrefs', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('onerror');
    expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script');
    // A javascript: link keeps the text but drops the dangerous href.
    expect(renderMarkdown('[click](javascript:alert(1))')).not.toContain('javascript:');
  });
});

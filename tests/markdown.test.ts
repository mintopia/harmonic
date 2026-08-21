// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../web/src/markdown.js';

describe('renderMarkdown', () => {
  it('renders common Markdown to HTML', async () => {
    const html = await renderMarkdown('# H\n\nSome **bold** and `code` and a [link](https://x.com).\n\n- a\n- b');
    expect(html).toContain('<h1>H</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('href="https://x.com"');
  });

  it('opens links in a new tab safely', async () => {
    const html = await renderMarkdown('[x](https://x.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('strips XSS: inline handlers, scripts, and javascript: hrefs', async () => {
    expect(await renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('onerror');
    expect(await renderMarkdown('<script>alert(1)</script>')).not.toContain('<script');
    // A javascript: link keeps the text but drops the dangerous href.
    expect(await renderMarkdown('[click](javascript:alert(1))')).not.toContain('javascript:');
  });
});

import DOMPurify from 'dompurify';

/**
 * Render tracker-issue Markdown to sanitized HTML. `marked` handles the full
 * GFM grammar; DOMPurify strips anything unsafe (scripts, event handlers,
 * `javascript:` hrefs) since the source is tracker-authored, not ours. Links
 * open in a new tab. Styling lives in index.css under `.markdown`.
 *
 * `marked` is the heaviest thing on this path and only tracker-issue detail
 * views need it, so it's dynamically imported — it stays out of the main bundle
 * and loads the first time Markdown is rendered.
 */

// Force every link to open safely in a new tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export async function renderMarkdown(src: string): Promise<string> {
  const { marked } = await import('marked');
  const html = marked.parse(src, { gfm: true, breaks: true, async: false });
  return DOMPurify.sanitize(html);
}

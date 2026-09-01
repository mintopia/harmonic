import DOMPurify from 'dompurify';

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

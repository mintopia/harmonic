import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { highlightCode } from './syntax';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight: highlightCode,
  }),
);

export async function renderMarkdown(src: string): Promise<string> {
  const html = marked.parse(src, { gfm: true, breaks: true, async: false });
  return DOMPurify.sanitize(html);
}

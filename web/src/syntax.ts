import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

export function highlightCode(code: string, language?: string): string {
  const html = language && hljs.getLanguage(language)
    ? hljs.highlight(code, { language }).value
    : hljs.highlightAuto(code).value;
  return typeof DOMPurify.sanitize === 'function' ? DOMPurify.sanitize(html) : html;
}

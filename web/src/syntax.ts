import hljs from 'highlight.js';

export function highlightCode(code: string, language?: string): string {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language }).value;
  }

  return hljs.highlightAuto(code).value;
}

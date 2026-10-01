import { toastError } from './toast';

export type CopySource = string | (() => Promise<string>);

/** Write to the clipboard. A lazy source is handed to the browser as a pending
 * ClipboardItem so Safari keeps the user gesture while the text is fetched. */
export async function writeClipboard(source: CopySource): Promise<void> {
  if (typeof source === 'string') {
    await navigator.clipboard.writeText(source);
    return;
  }
  if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
    const blob = source().then((text) => new Blob([text], { type: 'text/plain' }));
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    return;
  }
  await navigator.clipboard.writeText(await source());
}

/** Copy and report failure as a toast. Resolves true when the text reached the clipboard. */
export async function copyText(source: CopySource): Promise<boolean> {
  try {
    await writeClipboard(source);
    return true;
  } catch (e) {
    toastError(new Error(`Could not copy to the clipboard${e instanceof Error && e.message ? `: ${e.message}` : '.'}`));
    return false;
  }
}

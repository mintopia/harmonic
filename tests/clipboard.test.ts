// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.fn();
vi.mock('../web/src/toast.js', () => ({ toastError: (e: unknown) => toastError(e) }));

import { copyText } from '../web/src/clipboard.js';

let writeText: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;

class FakeClipboardItem {
  constructor(public items: Record<string, Promise<Blob>>) {}
}

beforeEach(() => {
  toastError.mockReset();
  writeText = vi.fn().mockResolvedValue(undefined);
  write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText, write }, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe('copyText', () => {
  it('writes a string source with writeText', async () => {
    await expect(copyText('plain')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('plain');
    expect(write).not.toHaveBeenCalled();
  });

  it('hands a lazy source to the browser as a pending ClipboardItem', async () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    await expect(copyText(() => Promise.resolve('lazy'))).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const [[item]] = write.mock.calls[0] as [[FakeClipboardItem]];
    expect(await (await item.items['text/plain']!).text()).toBe('lazy');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to writeText when ClipboardItem is unavailable', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    await expect(copyText(() => Promise.resolve('lazy'))).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('lazy');
    expect(write).not.toHaveBeenCalled();
  });

  it('falls back to writeText when clipboard.write is missing', async () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await expect(copyText(() => Promise.resolve('lazy'))).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('lazy');
  });

  it('toasts and resolves false when the clipboard write fails', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    await expect(copyText('x')).resolves.toBe(false);
    expect(String(toastError.mock.calls[0]![0])).toContain('denied');
  });

  it('toasts and resolves false when the ClipboardItem write fails', async () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    write.mockRejectedValue(new Error('not allowed'));
    await expect(copyText(() => Promise.resolve('lazy'))).resolves.toBe(false);
    expect(String(toastError.mock.calls[0]![0])).toContain('not allowed');
  });
});

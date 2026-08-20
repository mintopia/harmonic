import { open, type FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/**
 * A line-fold an incremental tail (#217) drives. The cursor re-folds the
 * trailing line every tick until its newline arrives, so `fold` MUST be
 * idempotent to re-folding the exact same line: claude dedupes on message
 * id/line, codex's cumulative-delta baseline makes a repeat entry a zero
 * delta. Both a whole-file scan and the `LineCursor` fold into the same
 * accumulator type, so the two paths share one accounting.
 */
export interface LineAccumulator {
  fold(line: string): void;
}

/**
 * An incremental byte-offset reader over one append-only line log (#217).
 * Each `advance()` reads only the bytes appended since the previous call,
 * off the event loop, and folds the newly-completed lines into an
 * accumulator. The trailing line after the last newline is kept as `carry`
 * and *also* folded speculatively: a real in-progress write is invalid JSON
 * the accumulator drops, while a genuinely complete final line with no
 * trailing newline (what a whole-file scan would still parse) is counted now
 * — and re-folding it once its newline arrives is a no-op (see
 * `LineAccumulator`). A `StringDecoder` carries a UTF-8 multibyte sequence
 * split across a read boundary. On a shrunk file (truncation/rotation — rare
 * for append-only logs) the accumulator is rebuilt from a fresh instance and
 * the file re-read from the top, rather than folding new content onto
 * already-counted tokens.
 */
export class LineCursor<A extends LineAccumulator> {
  private offset = 0;
  private carry = '';
  private decoder = new StringDecoder('utf8');
  private current: A;

  constructor(
    private readonly file: string,
    private readonly makeAcc: () => A,
  ) {
    this.current = makeAcc();
  }

  /** The live accumulator; replaced on truncation, so always read it fresh. */
  get acc(): A {
    return this.current;
  }

  async advance(): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.file, 'r');
      const { size } = await handle.stat();
      if (size < this.offset) this.reset(); // truncated/rotated: re-read from the top
      if (size <= this.offset) return;
      const length = size - this.offset;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, this.offset);
      this.offset += bytesRead;
      const text = this.carry + this.decoder.write(buf.subarray(0, bytesRead));
      const lastNl = text.lastIndexOf('\n');
      if (lastNl >= 0) {
        this.carry = text.slice(lastNl + 1);
        for (const line of text.slice(0, lastNl).split('\n')) this.current.fold(line);
      } else {
        this.carry = text;
      }
      // Speculatively fold the trailing line: a complete final line with no
      // newline is real, a partial write is invalid the fold drops, and the
      // accumulator makes a later re-fold a no-op.
      if (this.carry) this.current.fold(this.carry);
    } catch {
      // Not written yet, vanished, or a transient read error: keep what we have.
      // Never throw — a sampler must not fail a run.
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private reset(): void {
    this.offset = 0;
    this.carry = '';
    this.decoder = new StringDecoder('utf8');
    this.current = this.makeAcc();
  }
}

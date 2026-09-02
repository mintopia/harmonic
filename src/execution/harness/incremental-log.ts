import { open, type FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/**
 * A line-fold an incremental tail drives. The cursor re-folds the trailing
 * line every tick until its newline arrives, so `fold` MUST be idempotent to
 * re-folding the exact same line.
 */
export interface LineAccumulator {
  fold(line: string): void;
}

/**
 * An incremental byte-offset reader over one append-only line log. Each
 * `advance()` reads only the bytes appended since the previous call and folds
 * the newly-completed lines into an accumulator. The trailing line after the
 * last newline is kept as `carry` and also folded speculatively (a partial
 * write is invalid JSON the accumulator drops; a complete final line with no
 * trailing newline is counted now). A `StringDecoder` carries a UTF-8
 * multibyte sequence split across a read boundary. On a shrunk file the
 * accumulator is rebuilt from a fresh instance and the file re-read from the
 * top.
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
      if (size < this.offset) this.reset();
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
      if (this.carry) this.current.fold(this.carry);
    } catch {
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

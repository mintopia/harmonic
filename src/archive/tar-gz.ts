import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import { createGzip, type Gzip } from 'node:zlib';
import { yieldToEventLoop } from '../reliability/yield.js';

export interface ByteTransform {
  push(chunk: Buffer): Buffer;
  end(): Buffer;
}

export type TransformFactory = (pass: 'measure' | 'write') => ByteTransform;

async function* readRange(path: string, size: number): AsyncGenerator<Buffer> {
  if (size === 0) return;
  const source = createReadStream(path, { start: 0, end: size - 1 });
  try {
    for await (const chunk of source) yield chunk as Buffer;
  } finally {
    source.destroy();
  }
}

async function transformedSize(path: string, size: number, transform: ByteTransform): Promise<number> {
  let total = 0;
  for await (const chunk of readRange(path, size)) total += transform.push(chunk).length;
  return total + transform.end().length;
}

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const MAX_OCTAL_11 = 0o77777777777;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function isAscii(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') === text.length;
}

function splitUstarName(name: string): { prefix: string; name: string } | null {
  if (!isAscii(name)) return null;
  if (name.length <= 100) return { prefix: '', name };
  for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (prefix.length > 155) break;
    if (rest.length > 0 && rest.length <= 100) return { prefix, name: rest };
  }
  return null;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, 'utf8');
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return Buffer.from(`${len}${body}`, 'utf8');
}

function buildHeader(
  name: string,
  prefix: string,
  size: number,
  mtime: Date,
  typeflag: string,
): Buffer {
  if (size > MAX_OCTAL_11) throw new RangeError(`tar entry too large: ${size} bytes`);
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'latin1');
  header.write(octal(0o644, 8), 100, 'latin1');
  header.write(octal(0, 8), 108, 'latin1');
  header.write(octal(0, 8), 116, 'latin1');
  header.write(octal(size, 12), 124, 'latin1');
  header.write(octal(Math.max(0, Math.floor(mtime.getTime() / 1000)), 12), 136, 'latin1');
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  header.write(prefix, 345, 155, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return header;
}

export class TarGzWriter {
  private readonly gzip: Gzip;
  private readonly out: Writable;
  private readonly failure: Promise<never>;
  private readonly fail: (err: Error) => void;
  private error: Error | null = null;
  private busy = false;
  private finishing = false;

  constructor(out: NodeJS.WritableStream) {
    this.out = out as Writable;
    this.gzip = createGzip();
    let fail!: (err: Error) => void;
    this.failure = new Promise<never>((_, reject) => {
      fail = reject;
    });
    this.fail = fail;
    this.failure.catch(() => undefined);
    const onError = (err: Error): void => {
      if (this.error) return;
      this.error = err;
      fail(err);
    };
    this.gzip.on('error', onError);
    this.out.on('error', onError);
    this.gzip.pipe(this.out);
  }

  abort(err: Error = new Error('TarGzWriter aborted')): void {
    if (!this.error) {
      this.error = err;
      this.fail(err);
    }
    this.gzip.destroy();
    this.out.destroy();
  }

  async addBuffer(name: string, data: string | Buffer, mtime: Date = new Date()): Promise<void> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    await this.exclusive(async () => {
      await this.writeHeaders(name, buf.length, mtime);
      await this.write(buf);
      await this.pad(buf.length);
    });
  }

  async addFile(name: string, path: string, transform?: TransformFactory): Promise<void> {
    await this.exclusive(async () => {
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`not a regular file: ${path}`);
      const size = transform ? await transformedSize(path, info.size, transform('measure')) : info.size;
      await this.writeHeaders(name, size, info.mtime);
      let written = 0;
      const emit = async (piece: Buffer): Promise<void> => {
        const part = piece.subarray(0, Math.max(0, size - written));
        written += part.length;
        if (part.length > 0) await this.write(part);
      };
      const t = transform?.('write');
      for await (const chunk of readRange(path, info.size)) await emit(t ? t.push(chunk) : chunk);
      if (t) await emit(t.end());
      if (written < size) await this.write(Buffer.alloc(size - written));
      await this.pad(size);
    });
  }

  async finish(): Promise<void> {
    await this.exclusive(async () => {
      this.finishing = true;
      const done = finished(this.out);
      done.catch(() => undefined);
      this.gzip.write(ZERO_BLOCK);
      this.gzip.write(ZERO_BLOCK);
      this.gzip.end();
      await Promise.race([done, this.failure]);
    });
  }

  private async exclusive(fn: () => Promise<void>): Promise<void> {
    if (this.busy) throw new Error('TarGzWriter entries must be awaited in order');
    if (this.finishing) throw new Error('TarGzWriter already finished');
    this.busy = true;
    try {
      if (this.error) throw this.error;
      await fn();
    } finally {
      this.busy = false;
    }
  }

  private async writeHeaders(name: string, size: number, mtime: Date): Promise<void> {
    const split = splitUstarName(name);
    if (split) {
      await this.write(buildHeader(split.name, split.prefix, size, mtime, '0'));
      return;
    }
    const records = paxRecord('path', name);
    await this.write(buildHeader('PaxHeader', '', records.length, mtime, 'x'));
    await this.write(records);
    await this.pad(records.length);
    const fallback = name.replace(/[^\x20-\x7e]/g, '_').slice(-100);
    await this.write(buildHeader(fallback, '', size, mtime, '0'));
  }

  private async pad(size: number): Promise<void> {
    const remainder = size % BLOCK;
    if (remainder !== 0) await this.write(ZERO_BLOCK.subarray(0, BLOCK - remainder));
  }

  private async write(chunk: Buffer): Promise<void> {
    if (this.error) throw this.error;
    if (this.gzip.write(chunk)) return;
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
      this.gzip.once('drain', resolve);
    });
    try {
      await Promise.race([drained, this.failure]);
    } finally {
      this.gzip.off('drain', release);
    }
  }
}

export async function addDirectory(
  writer: TarGzWriter,
  root: string,
  prefix: string,
  transform?: TransformFactory,
): Promise<number> {
  let count = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        await writer.addFile(`${prefix}/${relPath}`, join(dir, entry.name), transform);
        count++;
        await yieldToEventLoop();
      }
    }
  };
  await walk(root, '');
  return count;
}

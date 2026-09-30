import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDirectory, TarGzWriter } from '../src/archive/tar-gz.js';

const run = promisify(execFile);
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tar-gz-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function build(fn: (w: TarGzWriter) => Promise<void>): Promise<string> {
  const archive = join(tmp, 'out.tar.gz');
  const writer = new TarGzWriter(createWriteStream(archive));
  await fn(writer);
  await writer.finish();
  return archive;
}

async function extract(archive: string): Promise<string> {
  const dest = join(tmp, 'x');
  await mkdir(dest, { recursive: true });
  await run('tar', ['-xzf', archive, '-C', dest]);
  return dest;
}

async function list(archive: string): Promise<string[]> {
  const { stdout } = await run('tar', ['-tzf', archive], { maxBuffer: 1 << 24 });
  return stdout.split('\n').filter(Boolean);
}

describe('TarGzWriter', () => {
  it('writes buffer entries in order', async () => {
    const archive = await build(async (w) => {
      await w.addBuffer('b.txt', 'second');
      await w.addBuffer('a/a.bin', Buffer.from([0, 1, 2, 255]));
      await w.addBuffer('c.txt', 'x'.repeat(512));
    });
    expect(await list(archive)).toEqual(['b.txt', 'a/a.bin', 'c.txt']);
    const dest = await extract(archive);
    expect(await readFile(join(dest, 'b.txt'), 'utf8')).toBe('second');
    expect([...(await readFile(join(dest, 'a/a.bin')))]).toEqual([0, 1, 2, 255]);
    expect((await readFile(join(dest, 'c.txt'), 'utf8')).length).toBe(512);
  });

  it('streams a large file and an empty file', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    await writeFile(join(tmp, 'big.bin'), big);
    await writeFile(join(tmp, 'empty'), '');
    const archive = await build(async (w) => {
      await w.addFile('big.bin', join(tmp, 'big.bin'));
      await w.addFile('empty', join(tmp, 'empty'));
    });
    const dest = await extract(archive);
    expect((await readFile(join(dest, 'big.bin'))).equals(big)).toBe(true);
    expect((await readFile(join(dest, 'empty'))).length).toBe(0);
  });

  it('sizes and writes a file through a length-changing transform', async () => {
    await writeFile(join(tmp, 'log.txt'), 'a-b-c\n'.repeat(50_000));
    await writeFile(join(tmp, 'after.txt'), 'next');
    const passes: string[] = [];
    const archive = await build(async (w) => {
      await w.addFile('log.txt', join(tmp, 'log.txt'), (pass) => {
        passes.push(pass);
        return { push: (chunk) => Buffer.from(chunk.toString('latin1').replaceAll('-', '--'), 'latin1'), end: () => Buffer.from('END') };
      });
      await w.addFile('after.txt', join(tmp, 'after.txt'));
    });
    expect(passes).toEqual(['measure', 'write']);
    const dest = await extract(archive);
    expect(await readFile(join(dest, 'log.txt'), 'utf8')).toBe(`${'a--b--c\n'.repeat(50_000)}END`);
    expect(await readFile(join(dest, 'after.txt'), 'utf8')).toBe('next');
  });

  it('adds a nested directory sorted, skipping symlinks', async () => {
    const root = join(tmp, 'src');
    await mkdir(join(root, 'sub/deep'), { recursive: true });
    await writeFile(join(root, 'b.txt'), 'B');
    await writeFile(join(root, 'a.txt'), 'A');
    await writeFile(join(root, 'sub/deep/z.txt'), 'Z');
    await symlink(join(root, 'a.txt'), join(root, 'link.txt'));
    let count = 0;
    const archive = await build(async (w) => {
      count = await addDirectory(w, root, 'pfx');
    });
    expect(count).toBe(3);
    expect(await list(archive)).toEqual(['pfx/a.txt', 'pfx/b.txt', 'pfx/sub/deep/z.txt']);
    const dest = await extract(archive);
    expect(await readFile(join(dest, 'pfx/sub/deep/z.txt'), 'utf8')).toBe('Z');
  });

  it('splits long paths into ustar prefix and name', async () => {
    const name = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.txt`;
    expect(name.length).toBeGreaterThan(100);
    const archive = await build((w) => w.addBuffer(name, 'long'));
    expect(await list(archive)).toEqual([name]);
    expect(await readFile(join(await extract(archive), name), 'utf8')).toBe('long');
  });

  it('uses PAX for over-long paths and components', async () => {
    const longPath = Array.from({ length: 6 }, (_, i) => `${String(i)}${'p'.repeat(60)}`).join('/') + '/f.txt';
    const longComponent = `dir/${'c'.repeat(150)}.txt`;
    expect(longPath.length).toBeGreaterThan(255);
    const archive = await build(async (w) => {
      await w.addBuffer(longPath, 'one');
      await w.addBuffer(longComponent, 'two');
    });
    expect(await list(archive)).toEqual([longPath, longComponent]);
    const dest = await extract(archive);
    expect(await readFile(join(dest, longPath), 'utf8')).toBe('one');
    expect(await readFile(join(dest, longComponent), 'utf8')).toBe('two');
  });

  it('handles non-ASCII names', async () => {
    const archive = await build((w) => w.addBuffer('naïve/файл.txt', 'привет'));
    expect(await list(archive)).toEqual(['naïve/файл.txt']);
    expect(await readFile(join(await extract(archive), 'naïve/файл.txt'), 'utf8')).toBe('привет');
  });

  it('rejects finish when the output stream errors', async () => {
    const out = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error('disk full'));
      },
    });
    out.on('error', () => undefined);
    const writer = new TarGzWriter(out);
    await writer.addBuffer('a.txt', 'a').catch(() => undefined);
    await expect(writer.finish()).rejects.toThrow('disk full');
  });

  it('rejects a pending addFile and finish when aborted mid-write', async () => {
    const big = join(tmp, 'big.bin');
    await writeFile(big, Buffer.alloc(64 * 1024 * 1024, 7));
    const out = new Writable({
      highWaterMark: 1,
      write() {
        return undefined;
      },
    });
    const writer = new TarGzWriter(out);
    const pending = writer.addFile('big.bin', big);
    const outcome = expect(pending).rejects.toThrow('stop');
    await new Promise((r) => setTimeout(r, 50));

    writer.abort(new Error('stop'));

    await outcome;
    await expect(writer.finish()).rejects.toThrow('stop');
    await expect(writer.addBuffer('a', 'a')).rejects.toThrow('stop');
  });

  it('rejects a drain wait when the output is destroyed without an error', async () => {
    const big = join(tmp, 'big2.bin');
    await writeFile(big, Buffer.alloc(32 * 1024 * 1024, 1));
    const out = new Writable({
      highWaterMark: 1,
      write() {
        return undefined;
      },
    });
    const writer = new TarGzWriter(out);
    const pending = writer.addFile('big.bin', big);
    const outcome = expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50));

    writer.abort();

    await outcome;
  });
});

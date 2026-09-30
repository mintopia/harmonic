import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type TestServer } from './helpers.js';

const SECRET = 'fake-secret-key-9876';
const ACCESS = 'fake-access-id';

interface FakeS3 {
  endpoint: string;
  objects: Set<string>;
  puts: string[];
  failDelete: boolean;
  close: () => Promise<void>;
}

async function fakeS3(buckets: string[]): Promise<FakeS3> {
  const fake = { objects: new Set<string>(), puts: [] as string[], failDelete: false } as FakeS3;
  const srv: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const [, bucket = '', ...rest] = decodeURIComponent((req.url ?? '').split('?')[0] ?? '').split('/');
      const key = rest.join('/');
      if (!buckets.includes(bucket)) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message><BucketName>${bucket}</BucketName></Error>`);
        return;
      }
      if (req.method === 'PUT') {
        fake.objects.add(`${bucket}/${key}`);
        fake.puts.push(`${bucket}/${key}`);
        res.writeHead(200, { etag: '"x"' });
      } else if (req.method === 'DELETE' && fake.failDelete) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>delete denied</Message></Error>');
        return;
      } else {
        fake.objects.delete(`${bucket}/${key}`);
        res.writeHead(204);
      }
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  fake.endpoint = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  fake.close = () => new Promise((r) => srv.close(() => r()));
  return fake;
}

describe('POST /api/export/test-destination', () => {
  let server: TestServer;
  let s3: FakeS3;
  let tmp: string;

  const post = (body: Record<string, unknown>) => server.api('POST', '/api/export/test-destination', body);
  const putConfig = async (patch: Record<string, unknown>) => {
    const current = (await server.api('GET', '/api/config')).body;
    return server.api('PUT', '/api/config', { ...current, export: { ...current.export, ...patch } });
  };
  const s3Config = (extra: Record<string, unknown> = {}) => ({
    s3: { endpoint: s3.endpoint, region: 'us-east-1', bucket: 'good', prefix: 'pre', forcePathStyle: true, accessKeyId: ACCESS, secretAccessKey: SECRET, ...extra },
  });

  beforeEach(async () => {
    server = await startServer();
    s3 = await fakeS3(['good', 'other']);
    tmp = mkdtempSync(join(tmpdir(), 'harmonic-dest-'));
  });
  afterEach(async () => {
    await server.close();
    await s3.close();
    chmodSync(tmp, 0o755);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('directory success creates the path and leaves no probe file', async () => {
    const path = join(tmp, 'nested', 'out');
    await putConfig({ directory: { path } });
    const res = await post({ destination: 'directory' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ destination: 'directory', ok: true });
    expect(Date.parse(res.body.testedAt)).not.toBeNaN();
    expect(res.body.error).toBeUndefined();
    expect(readdirSync(path)).toEqual([]);
  });

  it('an unwritable directory reports ok:false, not a 5xx', async () => {
    const locked = join(tmp, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    await putConfig({ directory: { path: join(locked, 'out') } });
    const res = await post({ destination: 'directory', workspaceId: null });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/EACCES|EPERM|permission/i);
  });

  it('s3 success puts then deletes the probe under the prefix', async () => {
    await putConfig(s3Config());
    const res = await post({ destination: 's3' });
    expect(res.body).toMatchObject({ destination: 's3', ok: true });
    expect(s3.puts).toHaveLength(1);
    expect(s3.puts[0]).toMatch(/^good\/pre\/\.harmonic-test-/);
    expect(s3.objects.size).toBe(0);
  });

  it('a wrong bucket is ok:false with the S3 error, leaves no object, and leaks no credentials', async () => {
    await putConfig(s3Config({ bucket: 'missing' }));
    const res = await post({ destination: 's3' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('NoSuchBucket');
    expect(s3.objects.size).toBe(0);
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${SECRET}|${ACCESS}`));
  });

  it('put ok but delete failing reports the error', async () => {
    await putConfig(s3Config());
    s3.failDelete = true;
    const res = await post({ destination: 's3' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('AccessDenied');
  });

  it('uses the Workspace override bucket', async () => {
    await putConfig(s3Config());
    const id = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id as number;
    await server.api('PATCH', `/api/workspaces/${id}`, { exportS3Bucket: 'other' });
    const res = await post({ destination: 's3', workspaceId: String(id) });
    expect(res.body.ok).toBe(true);
    expect(s3.puts[0]).toMatch(/^other\//);
  });

  it('404 for an unknown workspace, 400 when the destination is not configured', async () => {
    expect((await post({ destination: 'directory', workspaceId: '999999' })).status).toBe(404);
    expect((await post({ destination: 'directory' })).status).toBe(400);
    expect((await post({ destination: 's3' })).status).toBe(400);
  });
});

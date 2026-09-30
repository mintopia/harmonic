import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { ResolvedS3Settings } from './export-settings.js';

const MAX_COLLISIONS = 1000;
const PROBE_TIMEOUT_MS = 15_000;

function isCollision(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;
  return status === 412 || e.name === 'PreconditionFailed' || e.name === 'ConditionalRequestConflict';
}

function client(s3: ResolvedS3Settings): S3Client {
  return new S3Client({
    ...(s3.endpoint !== null ? { endpoint: s3.endpoint } : {}),
    ...(s3.region !== null ? { region: s3.region } : s3.endpoint !== null ? { region: 'us-east-1' } : {}),
    forcePathStyle: s3.forcePathStyle,
    ...(s3.credentials !== null ? { credentials: s3.credentials } : {}),
  });
}

function keyPrefix(prefix: string): string {
  return prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/** Uploads without overwriting: a taken key gets `-1`, `-2`, ... appended. Returns the `s3://bucket/key` URI. */
export async function uploadToS3(s3: ResolvedS3Settings, staged: string, slug: string, base: string): Promise<string> {
  const s3Client = client(s3);
  try {
    const { size } = await stat(staged);
    for (let n = 0; n < MAX_COLLISIONS; n++) {
      const key = `${keyPrefix(s3.prefix)}${slug}/${base}${n === 0 ? '' : `-${n}`}.tar.gz`;
      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: s3.bucket,
            Key: key,
            Body: createReadStream(staged),
            ContentLength: size,
            ContentType: 'application/gzip',
            IfNoneMatch: '*',
          }),
        );
        return `s3://${s3.bucket}/${key}`;
      } catch (err) {
        if (!isCollision(err)) throw err;
      }
    }
    throw new Error(`no free S3 key for ${base} after ${MAX_COLLISIONS} attempts`);
  } finally {
    s3Client.destroy();
  }
}

/** Puts then deletes a uniquely named probe object under the prefix; throws the S3 error on failure. */
export async function probeS3(s3: ResolvedS3Settings): Promise<void> {
  const s3Client = client(s3);
  try {
    const key = `${keyPrefix(s3.prefix)}.harmonic-test-${randomUUID()}`;
    const abortSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    await s3Client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: 'harmonic export destination test' }), { abortSignal });
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }), { abortSignal });
    } catch (err) {
      const e = err as Error;
      e.message = `${e.message} (probe object ${key} was not deleted)`;
      throw e;
    }
  } finally {
    s3Client.destroy();
  }
}

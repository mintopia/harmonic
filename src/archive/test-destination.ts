import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedExportSettings } from './export-settings.js';
import { probeS3 } from './s3-destination.js';

export type ExportDestinationKind = 'directory' | 's3';

export interface DestinationTestResult {
  destination: ExportDestinationKind;
  ok: boolean;
  error?: string;
  testedAt: string;
}

function describe(err: unknown, secrets: readonly string[]): string {
  const e = err as { name?: string; message?: string };
  const text = e.name && e.message && !e.message.startsWith(e.name) ? `${e.name}: ${e.message}` : (e.message ?? String(err));
  return secrets.filter((s) => s !== '').reduce((out, s) => out.split(s).join('***'), text);
}

/** Caller guarantees the destination is configured. */
export async function testExportDestination(settings: ResolvedExportSettings, destination: ExportDestinationKind): Promise<DestinationTestResult> {
  const secrets = settings.s3?.credentials ? [settings.s3.credentials.accessKeyId, settings.s3.credentials.secretAccessKey] : [];
  let error: string | undefined;
  try {
    if (destination === 'directory') {
      const dir = settings.directoryPath as string;
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `.harmonic-test-${randomUUID()}`);
      try {
        await writeFile(probe, 'harmonic export destination test');
      } finally {
        await rm(probe, { force: true });
      }
    } else {
      await probeS3(settings.s3 as NonNullable<ResolvedExportSettings['s3']>);
    }
  } catch (err) {
    error = describe(err, secrets);
  }
  return { destination, ok: error === undefined, ...(error !== undefined ? { error } : {}), testedAt: new Date().toISOString() };
}

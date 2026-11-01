import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ExportDestination } from './task-archive.js';

const entrySchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  at: z.string(),
  error: z.string().nullable(),
  retry: z.number(),
  nextRetryAt: z.string().nullable(),
});

const ledgerSchema = z.object({ directory: entrySchema.optional(), s3: entrySchema.optional() });

export type DeliveryEntry = z.infer<typeof entrySchema>;
export type DeliveryState = z.infer<typeof ledgerSchema>;

export class DeliveryLedger {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  static under(dataDir: string): DeliveryLedger {
    return new DeliveryLedger(join(dataDir, 'archive', 'delivery-state.json'));
  }

  async read(): Promise<DeliveryState> {
    try {
      const parsed = ledgerSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  note(destination: ExportDestination, entry: DeliveryEntry): Promise<void> {
    const next = this.chain.catch(() => undefined).then(async () => {
      const state = await this.read();
      const previous = state[destination];
      if (previous && Date.parse(previous.at) > Date.parse(entry.at)) return;
      await this.write({ ...state, [destination]: entry });
    });
    this.chain = next;
    return next;
  }

  private async write(state: DeliveryState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(state)}\n`);
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

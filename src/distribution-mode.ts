import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DistributionMode = 'packaged' | 'source';

const applicationRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function detectDistributionMode(root = applicationRoot): DistributionMode {
  return existsSync(join(root, '.git')) ? 'source' : 'packaged';
}

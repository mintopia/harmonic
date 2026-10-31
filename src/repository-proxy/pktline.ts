export type Pkt = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' };

export const ZERO_SHA = '0'.repeat(40);

export function encodePkt(text: string | Buffer): Buffer {
  const data = typeof text === 'string' ? Buffer.from(text) : text;
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}

export const FLUSH = Buffer.from('0000');

export function readPkts(
  buf: Buffer,
  { start = 0, untilFlush = false }: { start?: number; untilFlush?: boolean } = {},
): { pkts: Pkt[]; end: number } {
  const pkts: Pkt[] = [];
  let at = start;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new Error('truncated pkt-line header');
    const len = parseInt(buf.toString('latin1', at, at + 4), 16);
    if (Number.isNaN(len)) throw new Error('invalid pkt-line length');
    if (len === 0) {
      pkts.push({ kind: 'flush' });
      at += 4;
      if (untilFlush) break;
      continue;
    }
    if (len === 1) {
      pkts.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (len < 4 || at + len > buf.length) throw new Error('invalid pkt-line length');
    pkts.push({ kind: 'data', data: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return { pkts, end: at };
}

export interface AdvertisedRef {
  sha: string;
  name: string;
}

export interface Advertisement {
  refs: AdvertisedRef[];
  capabilities: string;
}

export function parseAdvertisement(raw: Buffer): Advertisement {
  const { pkts } = readPkts(raw);
  const refs: AdvertisedRef[] = [];
  let capabilities = '';
  let seenRefs = false;
  for (const pkt of pkts) {
    if (pkt.kind !== 'data') continue;
    const line = pkt.data.toString('utf8');
    if (!seenRefs && line.startsWith('# service=')) continue;
    const nul = line.indexOf('\0');
    const head = (nul === -1 ? line : line.slice(0, nul)).replace(/\n$/, '');
    if (!seenRefs && nul !== -1) capabilities = line.slice(nul + 1).replace(/\n$/, '');
    seenRefs = true;
    const space = head.indexOf(' ');
    if (space === -1) continue;
    refs.push({ sha: head.slice(0, space), name: head.slice(space + 1) });
  }
  return { refs, capabilities };
}

export function buildAdvertisement(
  service: string,
  adv: Advertisement,
  allowedRefs: readonly string[],
): Buffer {
  const caps = adv.capabilities
    .split(' ')
    .filter((c) => c !== '' && !c.startsWith('symref='))
    .join(' ');
  const kept = adv.refs.filter((r) => allowedRefs.includes(r.name));
  const parts: Buffer[] = [encodePkt(`# service=${service}\n`), FLUSH];
  if (kept.length === 0) {
    parts.push(encodePkt(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    kept.forEach((ref, i) => {
      parts.push(encodePkt(i === 0 ? `${ref.sha} ${ref.name}\0${caps}\n` : `${ref.sha} ${ref.name}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

import type { RepositoryPass } from './pass.js';
import { readPkts, type Advertisement } from './pktline.js';

export type Decision = { allow: true } | { allow: false; reason: string };

const DENY = (reason: string): Decision => ({ allow: false, reason });

export function allowedRefs(pass: RepositoryPass): string[] {
  return [`refs/heads/${pass.baseBranch}`, `refs/heads/${pass.ticketBranch}`];
}

export function checkFetch(body: Buffer, pass: RepositoryPass, adv: Advertisement): Decision {
  const allowedShas = new Set(
    adv.refs.filter((r) => allowedRefs(pass).includes(r.name)).map((r) => r.sha),
  );
  let pkts;
  try {
    pkts = readPkts(body).pkts;
  } catch {
    return DENY('malformed fetch request');
  }
  for (const pkt of pkts) {
    if (pkt.kind !== 'data') continue;
    const line = pkt.data.toString('utf8');
    if (line.startsWith('want-ref ')) return DENY('want-ref is not permitted');
    if (!line.startsWith('want ')) continue;
    const sha = line.slice(5).split(/[\s\0]/)[0] ?? '';
    if (!allowedShas.has(sha)) return DENY(`fetching ${sha} is not permitted`);
  }
  return { allow: true };
}

export function checkPush(body: Buffer, pass: RepositoryPass): Decision {
  let pkts;
  try {
    pkts = readPkts(body, { untilFlush: true }).pkts;
  } catch {
    return DENY('malformed push request');
  }
  const ticketRef = `refs/heads/${pass.ticketBranch}`;
  let commands = 0;
  for (const pkt of pkts) {
    if (pkt.kind !== 'data') continue;
    const line = pkt.data.toString('utf8').split('\0')[0]!.replace(/\n$/, '');
    if (line.startsWith('shallow ')) continue;
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/.exec(line);
    if (!match) return DENY('unsupported push request');
    const [, , newSha, ref] = match as unknown as [string, string, string, string];
    if (ref !== ticketRef) return DENY(`pushing ${ref} is not permitted`);
    if (/^0+$/.test(newSha)) return DENY('deleting a branch is not permitted');
    commands += 1;
  }
  return commands === 0 ? DENY('push carries no commands') : { allow: true };
}

import { createRepositoryProxy } from './server.js';

const key = process.env.HARMONIC_PROXY_KEY;
if (!key) {
  process.stderr.write('HARMONIC_PROXY_KEY is required\n');
  process.exit(1);
}

const token = process.env.UPSTREAM_TOKEN;
const server = createRepositoryProxy({
  key,
  ...(token ? { upstreamAuth: { username: process.env.UPSTREAM_USERNAME ?? 'git', token } } : {}),
});
const port = Number(process.env.PORT ?? 8080);
server.listen(port, '0.0.0.0', () => process.stdout.write(`repository proxy listening on :${port}\n`));

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const apiStub = fileURLToPath(new URL('./src/story/api-stub.ts', import.meta.url));
const wsStub = fileURLToPath(new URL('./src/story/ws-stub.ts', import.meta.url));

/** Redirect the real `../api` / `../ws` imports (from anything under web/src,
 * except the story dir itself) to the fixture stubs, so the unmodified
 * TicketPage renders against fixtures with no network. */
function stubApiAndWs() {
  return {
    name: 'stub-api-ws',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      if (!importer || !importer.includes('/web/src/') || importer.includes('/web/src/story/')) return null;
      const base = source.split('/').pop()?.replace(/\.(ts|js)$/, '');
      if (base === 'api') return apiStub;
      if (base === 'ws') return wsStub;
      return null;
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [stubApiAndWs(), react(), tailwindcss()],
  server: { port: 47455, strictPort: true },
});

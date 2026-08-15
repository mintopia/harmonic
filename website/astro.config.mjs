// Astro + Starlight config for the Harmonic docs site.
// Deploys as a GitHub Pages *project* page at https://mintopia.github.io/harmonic/,
// so `site` + `base` must match that path exactly (see .github/workflows/docs.yml).
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://mintopia.github.io',
  base: '/harmonic',
  integrations: [
    starlight({
      title: 'Harmonic',
      description:
        'Queue, run, and review autonomous coding-agent tasks — trustworthy autonomy for Claude Code, Codex, and Copilot over ACP.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/mintopia/harmonic' },
      ],
      customCss: ['./src/styles/aurora.css'],
      // Aurora theme is dark-first: give a fresh visitor a dark default
      // instead of Starlight's default `auto` (prefers-color-scheme) pick.
      head: [
        {
          tag: 'script',
          content: `if (!localStorage.getItem('starlight-theme')) { localStorage.setItem('starlight-theme', 'dark'); }`,
        },
      ],
      plugins: [
        starlightOpenAPI([
          {
            base: 'reference/api',
            label: 'API reference',
            schema: './src/openapi.json',
          },
        ]),
      ],
      sidebar: [
        {
          label: 'Using Harmonic',
          items: [
            { label: 'Introduction', link: '/' },
            { label: 'Getting started', link: '/using-harmonic/getting-started/' },
            { label: 'Core concepts', link: '/using-harmonic/core-concepts/' },
            { label: 'Conversations', link: '/using-harmonic/conversations/' },
            { label: 'Harnesses', link: '/using-harmonic/harnesses/' },
            { label: 'Notifications', link: '/using-harmonic/notifications/' },
            { label: 'Settings & overrides', link: '/using-harmonic/settings-and-overrides/' },
            { label: 'Security', link: '/using-harmonic/security/' },
            { label: 'API & MCP', link: '/using-harmonic/api-and-mcp/' },
          ],
        },
        {
          label: 'How it works',
          items: [
            { label: 'Architecture', link: '/how-it-works/architecture/' },
            { label: 'ACP & harness adapters', link: '/how-it-works/acp-and-adapters/' },
            { label: 'Tracker mirroring & skills', link: '/how-it-works/tracker-mirroring/' },
            { label: 'Design decisions', link: '/how-it-works/design-decisions/' },
          ],
        },
        {
          label: 'Contributing',
          items: [
            { label: 'Development & contributing', link: '/contributing/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI reference', link: '/reference/cli/' },
            { label: 'Configuration reference', link: '/reference/configuration/' },
            { label: 'Glossary', link: '/reference/glossary/' },
          ],
        },
        ...openAPISidebarGroups,
      ],
    }),
  ],
});

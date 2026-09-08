// Deploys as a GitHub Pages *project* page at https://mintopia.github.io/harmonic/,
// so `site` + `base` must match that path exactly (see .github/workflows/docs.yml).
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://mintopia.github.io',
  base: '/harmonic',
  // `astro preview` blocks unknown Host headers (DNS-rebind protection); its
  // static preview server reads THIS key (server.allowedHosts), not
  // vite.preview.allowedHosts.
  server: {
    allowedHosts: true,
  },
  integrations: [
    starlight({
      title: 'Harmonic',
      logo: {
        light: './src/assets/harmonic-mark-light.svg',
        dark: './src/assets/harmonic-mark-dark.svg',
      },
      description:
        'Point Harmonic at your issue tracker and it works through your backlog on its own — driving Claude Code, Codex, Copilot, and OpenCode over ACP.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/mintopia/harmonic' },
      ],
      customCss: ['./src/styles/paper.css'],
      head: [
        {
          tag: 'script',
          content: `if (!localStorage.getItem('starlight-theme')) { localStorage.setItem('starlight-theme', 'dark'); }`,
        },
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Introduction', link: '/' },
            { label: 'Quickstart', link: '/start/quickstart/' },
            { label: 'Spec-driven dev', link: '/start/spec-driven-development/' },
          ],
        },
        {
          label: 'Using Harmonic',
          items: [
            { label: 'Feeding it work', link: '/work/feeding-it-work/' },
            { label: 'Steering the fleet', link: '/work/steering-the-fleet/' },
            { label: 'Review & merge', link: '/work/reviewing-and-merging/' },
            { label: 'Conversations', link: '/work/conversations/' },
            { label: 'Notifications', link: '/work/notifications/' },
          ],
        },
        {
          label: 'Running Harmonic',
          items: [
            { label: 'Harnesses', link: '/run/harnesses/' },
            { label: 'Settings', link: '/run/settings/' },
            { label: 'Security', link: '/run/security/' },
            { label: 'CLI', link: '/run/cli/' },
            { label: 'Configuration', link: '/run/configuration/' },
          ],
        },
      ],
    }),
  ],
});

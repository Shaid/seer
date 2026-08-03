import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://seer.shaid.net',
  integrations: [
    starlight({
      title: 'Seer',
      description:
        'A reusable framework for browser-based, data-file-first game reverse-engineering projects.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/Shaid/seer',
        },
      ],
      // 'Start Here', 'Packages', 'Guides' and 'Roadmap' are populated by
      // www/scripts/sync-docs.mjs from the real source docs (root docs/*.md,
      // packages/*/README.md) -- run automatically before dev/build/preview,
      // see package.json. Autogenerate means a new synced page (e.g. a new
      // package's README) shows up with no sidebar config changes needed.
      // 'Examples' is hand-authored directly in www, not synced from anywhere.
      sidebar: [
        { label: 'Start Here', items: [{ autogenerate: { directory: 'start-here' } }] },
        { label: 'Packages', items: [{ autogenerate: { directory: 'packages' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Roadmap', items: [{ autogenerate: { directory: 'roadmap' } }] },
        { label: 'Examples', items: [{ autogenerate: { directory: 'examples' } }] },
      ],
    }),
  ],
});

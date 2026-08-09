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
      // Every group below except 'Examples' is populated by
      // wwwdocs/scripts/sync-docs.mjs from the real source docs (root docs/*.md,
      // packages/*/README.md) -- run automatically before dev/build/preview,
      // see package.json. Autogenerate means a new synced page shows up with
      // no sidebar config changes needed; since sync-docs discovers package
      // READMEs from the filesystem, a whole new package needs no edit here
      // *or* there. 'Examples' is hand-authored directly in wwwdocs.
      sidebar: [
        { label: 'Start Here', items: [{ autogenerate: { directory: 'start-here' } }] },
        { label: 'Packages', items: [{ autogenerate: { directory: 'packages' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        {
          label: 'Recompilation',
          collapsed: true,
          items: [{ autogenerate: { directory: 'recompilation' } }],
        },
        { label: 'Roadmap', items: [{ autogenerate: { directory: 'roadmap' } }] },
        { label: 'Examples', items: [{ autogenerate: { directory: 'examples' } }] },
      ],
    }),
  ],
});

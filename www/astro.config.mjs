import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Seer',
      description:
        'A reusable framework for browser-based, data-file-first game reverse-engineering projects.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/anomalyco/seer',
        },
      ],
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'Architecture Overview', slug: 'architecture-overview' },
            { label: 'Boilerplate Guide', slug: 'boilerplate-guide' },
          ],
        },
        {
          label: 'Design',
          items: [{ label: 'Framework Plan', slug: 'framework-plan' }],
        },
        {
          label: 'Migration',
          items: [
            { label: 'Middilgard Migration', slug: 'middilgard-migration' },
          ],
        },
      ],
    }),
  ],
});

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { scaffoldWebsite, type WebsiteContext } from '../website.js';

const TMP = resolve(process.cwd(), 'packages/create-seer-app/src/__tests__/__out__/website');

function run(targetDir: string, ctx: WebsiteContext = {}): void {
  scaffoldWebsite(resolve(TMP, targetDir), ctx);
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('scaffoldWebsite', () => {
  it('creates root config files', () => {
    run('root/www');
    const dir = resolve(TMP, 'root/www');
    expect(existsSync(resolve(dir, 'package.json'))).toBe(true);
    expect(existsSync(resolve(dir, 'astro.config.mjs'))).toBe(true);
    expect(existsSync(resolve(dir, 'tsconfig.json'))).toBe(true);
    expect(existsSync(resolve(dir, '.gitignore'))).toBe(true);
    expect(existsSync(resolve(dir, 'README.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'WRITING-GUIDE.md'))).toBe(true);
  });

  it('renders the writing guide with the game ID and display name', () => {
    run('guide/www', { game: 'demo', displayName: 'Demo Game' });
    const guide = readFileSync(resolve(TMP, 'guide/www/WRITING-GUIDE.md'), 'utf-8');
    expect(guide).toContain('Demo Game');
    expect(guide).toContain('docs/demo/');
    expect(guide).toContain('src/content/docs/demo/_sidebar.json');
    // No unrendered Eta tags left behind.
    expect(guide).not.toContain('<%');
  });

  it('creates scripts/', () => {
    run('scripts/www');
    const dir = resolve(TMP, 'scripts/www');
    expect(existsSync(resolve(dir, 'scripts/build.mjs'))).toBe(true);
    expect(existsSync(resolve(dir, 'scripts/generate_favicon.mjs'))).toBe(true);
  });

  it('creates src/ files, using the game ID for the content directory', () => {
    run('src/www', { game: 'foobar' });
    const dir = resolve(TMP, 'src/www');
    expect(existsSync(resolve(dir, 'src/content.config.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'src/components/SpriteGallery.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'src/content/docs/index.mdx'))).toBe(true);
    expect(existsSync(resolve(dir, 'src/content/docs/foobar/index.mdx'))).toBe(true);
    expect(existsSync(resolve(dir, 'src/content/docs/foobar/getting-started.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'src/content/docs/foobar/_sidebar.json'))).toBe(true);
  });

  it('creates the Lightbox component and its client script', () => {
    run('lightbox/www');
    const dir = resolve(TMP, 'lightbox/www');
    expect(existsSync(resolve(dir, 'src/components/Lightbox.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'src/scripts/lightbox.js'))).toBe(true);
    const gallery = readFileSync(resolve(dir, 'src/components/SpriteGallery.astro'), 'utf-8');
    expect(gallery).toContain('data-lightbox');
  });

  it('copies a placeholder favicon', () => {
    run('favicon/www');
    const favicon = resolve(TMP, 'favicon/www/public/favicon.png');
    expect(existsSync(favicon)).toBe(true);
    // Valid PNG signature.
    const bytes = readFileSync(favicon);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('writes .github/workflows/deploy.yml one level above the target directory', () => {
    run('deploy/www');
    const deployPath = resolve(TMP, 'deploy/.github/workflows/deploy.yml');
    expect(existsSync(deployPath)).toBe(true);
    expect(existsSync(resolve(TMP, 'deploy/www/.github'))).toBe(false);
    const deploy = readFileSync(deployPath, 'utf-8');
    expect(deploy).toContain('path: www');
  });

  it('derives displayName from game ID when not given', () => {
    run('derived/www', { game: 'testgame' });
    const pkg = readFileSync(resolve(TMP, 'derived/www/README.md'), 'utf-8');
    expect(pkg).toContain('Testgame');
  });

  it('renders game/displayName/description/site into templates', () => {
    run('rendered/www', {
      game: 'demo',
      displayName: 'Demo Game',
      description: 'A demo.',
      site: 'https://demo.example',
    });
    const config = readFileSync(resolve(TMP, 'rendered/www/astro.config.mjs'), 'utf-8');
    expect(config).toContain("site: 'https://demo.example'");
    expect(config).toContain('Demo Game — Data Formats');
    expect(config).toContain('A demo.');
    const build = readFileSync(resolve(TMP, 'rendered/www/scripts/build.mjs'), 'utf-8');
    expect(build).toContain("GAME = 'demo'");
  });

  it('uses defaults when no options are provided', () => {
    run('defaults/www');
    const config = readFileSync(resolve(TMP, 'defaults/www/astro.config.mjs'), 'utf-8');
    expect(config).toContain('site: undefined');
    expect(config).toContain('Mygame — Data Formats');
  });

  it('honors a custom siteDir for the deploy workflow path', () => {
    run('custom-sitedir/site', { siteDir: 'docs-site' });
    const deploy = readFileSync(
      resolve(TMP, 'custom-sitedir/.github/workflows/deploy.yml'),
      'utf-8',
    );
    expect(deploy).toContain('path: docs-site');
  });

  // A freshly scaffolded site must build before any extraction has been run.
  // scripts/build.mjs throws when it finds neither repo-root assets nor a
  // committed mirror, so the mirror directory has to exist from the start.
  it('creates the asset mirror directory so the first build succeeds', () => {
    run('assets-dir', { game: 'zonx' });
    expect(existsSync(resolve(TMP, 'assets-dir/public/assets/zonx'))).toBe(true);
  });
});

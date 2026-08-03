/**
 * create-seer-website — scaffolds a standalone Astro + Starlight docs site.
 *
 * Sourced from a real, working Astro+Starlight docs site (game-specific
 * content stripped out), so a freshly scaffolded project's docs site is a
 * genuinely working starting point, not boilerplate.
 *
 * Run via: npx create-seer-website <dir>
 */
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';

export interface WebsiteContext {
  /** Game ID (default: 'mygame'). Drives asset paths, content slugs, and the sidebar manifest location. */
  game?: string;
  /** Human-readable game name (default: derived from game ID). */
  displayName?: string;
  /** Short site description, used in the Starlight config and homepage tagline. */
  description?: string;
  /** Deployed site URL (default: '' — left blank rather than inventing a domain). */
  site?: string;
  /**
   * Sprite-atlas frame name to use as the generated favicon (default: '' —
   * favicon generation is skipped and a placeholder public/favicon.png ships
   * instead, until this is set to a real frame; see the generated README).
   */
  faviconFrame?: string;
  /** Directory (under public/assets/<game>/) containing the favicon atlas manifest+PNG. */
  faviconAtlasDir?: string;
  /** Manifest filename (under faviconAtlasDir) containing the favicon frame. */
  faviconManifest?: string;
  /** Path (relative to the project root) the site is scaffolded into — used only to fill in .github/workflows/deploy.yml's `path:`. Defaults to the target directory's own basename. */
  siteDir?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '../templates');
// autoTrim: false — several templates (e.g. frontmatter YAML, YAML-ish
// config files) interpolate a value as the last thing on a line; Eta's
// default auto-trim otherwise eats the trailing newline and merges it with
// the next line.
const eta = new Eta({ views: templatesDir, autoTrim: false });

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function write(filePath: string, content: string): void {
  writeFileSync(filePath, content);
}

function renderTemplate(templatePath: string, data: Record<string, string>): string {
  return eta.render(templatePath, data) as string;
}

/**
 * Scaffold a docs site at `targetDir` (e.g. `<project>/www`). Writes site
 * files under `targetDir`, plus `.github/workflows/deploy.yml` one level up
 * (at `dirname(targetDir)`) — deliberately outside the site directory it
 * otherwise scaffolds into, matching the CI-file-at-repo-root layout this
 * template is sourced from.
 */
export function scaffoldWebsite(targetDir: string, ctx: WebsiteContext = {}): void {
  const game = ctx.game ?? 'mygame';
  const displayName = ctx.displayName ?? capitalize(game);
  const description = ctx.description ?? `A reverse-engineering field guide to ${displayName}.`;
  const site = ctx.site ?? '';
  const faviconFrame = ctx.faviconFrame ?? '';
  const faviconAtlasDir = ctx.faviconAtlasDir ?? 'amiga/sprites';
  const faviconManifest = ctx.faviconManifest ?? 'items.json';
  const siteDir = ctx.siteDir ?? basename(resolve(targetDir));
  // Astro's `site` config must be a valid absolute URL or omitted entirely —
  // an empty string fails validation, so an unset `site` renders as the
  // literal `undefined` rather than `''`.
  const siteLiteral = site ? `'${site}'` : 'undefined';

  const data = { game, displayName, description, site, siteLiteral, faviconFrame, faviconAtlasDir, faviconManifest, siteDir };

  for (const dir of [
    '',
    'scripts',
    'src/components',
    'src/content/docs/' + game,
    'public',
  ]) {
    mkdirSync(resolve(targetDir, dir), { recursive: true });
  }

  const p = (rel: string) => resolve(targetDir, rel);

  // ── Root config files ──────────────────────────────────────────────

  write(p('package.json'), renderTemplate('package.json.eta', data));
  write(p('astro.config.mjs'), renderTemplate('astro.config.mjs.eta', data));
  write(p('tsconfig.json'), renderTemplate('tsconfig.json.eta', data));
  write(p('.gitignore'), renderTemplate('.gitignore.eta', data));
  write(p('README.md'), renderTemplate('README.md.eta', data));
  write(p('AGENTS.md'), renderTemplate('AGENTS.md.eta', data));

  // ── scripts/ ───────────────────────────────────────────────────────

  write(p('scripts/build.mjs'), renderTemplate('scripts/build.mjs.eta', data));
  write(p('scripts/generate_favicon.mjs'), renderTemplate('scripts/generate_favicon.mjs.eta', data));

  // ── src/ ───────────────────────────────────────────────────────────

  write(p('src/content.config.ts'), renderTemplate('src/content.config.ts.eta', data));
  write(p('src/components/SpriteGallery.astro'), renderTemplate('src/components/SpriteGallery.astro.eta', data));
  write(p('src/content/docs/index.mdx'), renderTemplate('src/content/docs/index.mdx.eta', data));
  write(p('src/content/docs/' + game + '/index.mdx'), renderTemplate('src/content/docs/game/index.mdx.eta', data));
  write(p('src/content/docs/' + game + '/getting-started.md'), renderTemplate('src/content/docs/game/getting-started.md.eta', data));
  write(p('src/content/docs/' + game + '/_sidebar.json'), renderTemplate('src/content/docs/game/_sidebar.json.eta', data));

  // ── public/ ────────────────────────────────────────────────────────
  // A placeholder favicon copied verbatim (binary, not Eta-rendered) — see
  // README.md for pointing scripts/build.mjs at a real sprite frame instead.

  copyFileSync(resolve(templatesDir, 'public/favicon.png'), p('public/favicon.png'));

  // ── CI (repo root, outside targetDir) ───────────────────────────────

  const repoRoot = resolve(targetDir, '..');
  mkdirSync(resolve(repoRoot, '.github/workflows'), { recursive: true });
  write(resolve(repoRoot, '.github/workflows/deploy.yml'), renderTemplate('.github/workflows/deploy.yml.eta', data));

  console.log('Scaffolded ' + displayName + ' docs site at ' + targetDir);
  console.log('  Next steps:');
  console.log('    cd ' + resolve(targetDir));
  console.log('    npm install');
  console.log('    npm run dev');
}

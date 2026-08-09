/**
 * Scaffolds a standalone Astro + Starlight docs site.
 *
 * Sourced from a real, working Astro+Starlight docs site (game-specific
 * content stripped out), so what you scaffold is a genuinely working starting
 * point, not boilerplate.
 *
 * Usable on its own (`create-seer-app website www`) so an existing project can
 * gain a docs site without being re-scaffolded — that is how the real
 * consuming projects picked one up.
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { capitalize, rendererFor, templatesFor, write } from './render.js';

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
  /**
   * Path (relative to the project root) the site is scaffolded into — used only
   * to fill in .github/workflows/deploy.yml's `path:`. Defaults to the target
   * directory's own basename.
   */
  siteDir?: string;
  /**
   * Emit `.github/workflows/deploy.yml` (GitHub Pages) one level above the
   * target. Default `true`. Set false when deploying somewhere else — the site
   * is a plain static build, so any host that can serve a directory works.
   */
  deployWorkflow?: boolean;
}

const render = rendererFor('website');

/**
 * Scaffold a docs site at `targetDir` (e.g. `<project>/www`). Writes site files
 * under `targetDir`, plus `.github/workflows/deploy.yml` one level up (at
 * `dirname(targetDir)`) — deliberately outside the site directory it otherwise
 * scaffolds into, matching the CI-file-at-repo-root layout this template is
 * sourced from.
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
  const deployWorkflow = ctx.deployWorkflow ?? true;
  // Astro's `site` config must be a valid absolute URL or omitted entirely —
  // an empty string fails validation, so an unset `site` renders as the literal
  // `undefined` rather than `''`.
  const siteLiteral = site ? `'${site}'` : 'undefined';

  const data = {
    game,
    displayName,
    description,
    site,
    siteLiteral,
    faviconFrame,
    faviconAtlasDir,
    faviconManifest,
    siteDir,
  };

  for (const dir of [
    '',
    'scripts',
    'src/components',
    'src/scripts',
    `src/content/docs/${game}`,
    'public',
    // scripts/build.mjs copies extracted assets from the repo root and falls
    // back to this site's own committed mirror, throwing when it finds
    // neither — the right guard for a real project, where "no assets" means
    // the extraction failed. A freshly scaffolded site has no extraction yet,
    // so create the mirror directory up front: without it, the very first
    // `npm run build` fails before the site has ever been touched.
    `public/assets/${game}`,
  ]) {
    mkdirSync(resolve(targetDir, dir), { recursive: true });
  }

  const p = (rel: string) => resolve(targetDir, rel);

  // ── Root config files ──────────────────────────────────────────────

  write(p('package.json'), render('package.json.eta', data));
  write(p('astro.config.mjs'), render('astro.config.mjs.eta', data));
  write(p('tsconfig.json'), render('tsconfig.json.eta', data));
  write(p('.gitignore'), render('.gitignore.eta', data));
  write(p('README.md'), render('README.md.eta', data));
  write(p('AGENTS.md'), render('AGENTS.md.eta', data));
  write(p('WRITING-GUIDE.md'), render('WRITING-GUIDE.md.eta', data));

  // ── scripts/ ───────────────────────────────────────────────────────

  write(p('scripts/build.mjs'), render('scripts/build.mjs.eta', data));
  write(p('scripts/generate_favicon.mjs'), render('scripts/generate_favicon.mjs.eta', data));

  // ── src/ ───────────────────────────────────────────────────────────

  write(p('src/content.config.ts'), render('src/content.config.ts.eta', data));
  write(
    p('src/components/SpriteGallery.astro'),
    render('src/components/SpriteGallery.astro.eta', data),
  );
  write(p('src/components/Lightbox.astro'), render('src/components/Lightbox.astro.eta', data));
  write(p('src/scripts/lightbox.js'), render('src/scripts/lightbox.js.eta', data));
  write(p('src/content/docs/index.mdx'), render('src/content/docs/index.mdx.eta', data));
  write(
    p(`src/content/docs/${game}/index.mdx`),
    render('src/content/docs/game/index.mdx.eta', data),
  );
  write(
    p(`src/content/docs/${game}/getting-started.md`),
    render('src/content/docs/game/getting-started.md.eta', data),
  );
  write(
    p(`src/content/docs/${game}/_sidebar.json`),
    render('src/content/docs/game/_sidebar.json.eta', data),
  );

  // ── public/ ────────────────────────────────────────────────────────
  // A placeholder favicon copied verbatim (binary, not Eta-rendered) — see
  // README.md for pointing scripts/build.mjs at a real sprite frame instead.

  copyFileSync(resolve(templatesFor('website'), 'public/favicon.png'), p('public/favicon.png'));

  // ── CI (repo root, outside targetDir) ───────────────────────────────
  //
  // Deliberately outside the site directory, matching the CI-file-at-repo-root
  // layout this template is sourced from — which also means it is the one
  // thing this scaffold writes where the caller did not point it. So: never
  // overwrite an existing workflow (deploy.yml is a common enough name that
  // clobbering one would be real data loss), and skip it entirely when the
  // target is not GitHub Pages.
  const repoRoot = resolve(targetDir, '..');
  const workflowPath = resolve(repoRoot, '.github/workflows/deploy.yml');

  if (!deployWorkflow) {
    console.log('Skipped the GitHub Pages workflow (--no-deploy-workflow).');
    console.log(`  The site builds to ${siteDir}/dist — deploy that anywhere static.`);
  } else if (existsSync(workflowPath)) {
    console.log(`Left the existing ${workflowPath} alone.`);
    console.log('  Add a build+deploy step for this site to it by hand, or delete it and re-run.');
  } else {
    mkdirSync(resolve(repoRoot, '.github/workflows'), { recursive: true });
    write(workflowPath, render('.github/workflows/deploy.yml.eta', data));
  }

  console.log(`Scaffolded ${displayName} docs site at ${targetDir}`);
  console.log('  Next steps:');
  console.log(`    cd ${resolve(targetDir)}`);
  console.log('    npm install');
  console.log('    npm run dev');
}

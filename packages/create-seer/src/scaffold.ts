/**
 * create-seer — project scaffolding.
 *
 * Generates a new seer project with multi-game/multi-platform support
 * pre-configured, one game/platform filled in as a working starting point.
 *
 * Run via: npx create-seer <project-name>
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import { scaffoldViewer } from 'create-seer-viewer';
import { scaffoldWebsite } from 'create-seer-website';

export interface ScaffoldOptions {
  /** Game ID for the pre-configured entry (default: 'mygame'). */
  game?: string;
  /** Platform ID for the pre-configured entry (default: 'amiga'). */
  platform?: string;
  /** Human-readable game name (default: derived from game ID). */
  displayName?: string;
  /** Include the asset viewer tool (delegates to create-seer-viewer). */
  viewer?: boolean;
  /** Include the Astro + Starlight docs site (delegates to create-seer-website). */
  docsSite?: boolean;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '../templates');
const eta = new Eta({ views: templatesDir });

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
 * Scaffold a new seer project at `targetDir`.
 * Uses Eta templates from the templates/ directory.
 */
export function scaffold(targetDir: string, options: ScaffoldOptions = {}): void {
  const game = options.game ?? 'mygame';
  const platform = options.platform ?? 'amiga';
  const displayName = options.displayName ?? capitalize(game);
  const viewer = options.viewer ?? false;
  const docsSite = options.docsSite ?? false;

  for (const dir of [
    '',
    'docs',
    'src/data',
    'src/engine',
    'data/' + game + '/' + platform,
    'tools/shared/__tests__',
    'tools/' + game,
  ]) {
    mkdirSync(resolve(targetDir, dir), { recursive: true });
  }

  const p = (rel: string) => resolve(targetDir, rel);

  const seerPackagesDir = resolve(__dirname, '../..');
  const inMonorepo = existsSync(resolve(seerPackagesDir, 'core/package.json'));
  const seerSpec = (name: string): string => {
    if (!inMonorepo) return '^0.1.0';
    if (!existsSync(resolve(seerPackagesDir, name, 'dist'))) {
      throw new Error(
        `create-seer: packages/${name}/dist not found. Run \`npm run build:packages\` from the ` +
          'repo root before scaffolding a project that links to monorepo packages.',
      );
    }
    let rel = relative(resolve(targetDir), resolve(seerPackagesDir, name));
    if (!rel.startsWith('.') && !rel.startsWith('/')) rel = './' + rel;
    return 'file:' + rel;
  };
  const ctx = {
    game,
    platform,
    displayName,
    seerCore: seerSpec('core'),
    seerEngine2d: seerSpec('engine-2d'),
    seerPipeline: seerSpec('pipeline'),
  };

  // ── Root config files ──────────────────────────────────────────────

  write(p('package.json'), renderTemplate('package.json.eta', ctx));
  write(p('tsconfig.json'), renderTemplate('tsconfig.json.eta', ctx));
  write(p('vite.config.ts'), renderTemplate('vite.config.ts.eta', ctx));
  write(p('eslint.config.js'), renderTemplate('eslint.config.js.eta', ctx));
  write(p('.prettierrc'), renderTemplate('.prettierrc.eta', ctx));
  write(p('index.html'), renderTemplate('index.html.eta', ctx));
  write(p('.gitignore'), renderTemplate('.gitignore.eta', ctx));

  // ── src/ ───────────────────────────────────────────────────────────

  write(p('src/game-id.ts'), renderTemplate('src/game-id.ts.eta', ctx));
  write(p('src/main.ts'), renderTemplate('src/main.ts.eta', ctx));
  write(p('src/data/GameData.ts'), renderTemplate('src/data/GameData.ts.eta', ctx));
  write(p('src/data/AssetLoader.ts'), renderTemplate('src/data/AssetLoader.ts.eta', ctx));

  // ── tools/ ─────────────────────────────────────────────────────────

  write(p('tools/shared/game-config.ts'), renderTemplate('tools/shared/game-config.ts.eta', ctx));
  write(p('tools/shared/__tests__/game-config.test.ts'), renderTemplate('tools/shared/__tests__/game-config.test.ts.eta', ctx));
  write(p('tools/extract-game-data.ts'), renderTemplate('tools/extract-game-data.ts.eta', ctx));
  write(p('tools/' + game + '/export-game-data.ts'), renderTemplate('tools/game/export-game-data.ts.eta', ctx));
  write(p('tools/' + game + '/build-assets.ts'), renderTemplate('tools/game/build-assets.ts.eta', ctx));

  // ── Viewer (optional, delegated to create-seer-viewer) ──────────────

  if (viewer) {
    scaffoldViewer(p('tools/viewer'), { game, platform, displayName });
  }

  // ── Docs site (optional, delegated to create-seer-website) ──────────

  if (docsSite) {
    scaffoldWebsite(p('www'), { game, displayName });
  }

  // ── Config & docs ──────────────────────────────────────────────────

  write(p('seer.config.ts'), renderTemplate('seer.config.ts.eta', ctx));
  write(p('README.md'), renderTemplate('README.md.eta', ctx));
  write(p('docs/architecture-overview.md'), renderTemplate('docs/architecture-overview.md.eta', ctx));
  write(p('docs/boilerplate-guide.md'), renderTemplate('docs/boilerplate-guide.md.eta', ctx));

  console.log('Scaffolded ' + displayName + ' project at ' + targetDir);
  console.log('  Next steps:');
  console.log('    cd ' + resolve(targetDir));
  console.log('    npm install');
  console.log('    npm run dev');
}

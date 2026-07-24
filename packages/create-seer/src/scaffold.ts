/**
 * create-seer — project scaffolding.
 *
 * Generates a new seer project with multi-game/multi-platform support
 * pre-configured, one game/platform filled in as a working starting point.
 *
 * Run via: npx create-seer <project-name>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';

export interface ScaffoldOptions {
  /** Game ID for the pre-configured entry (default: 'mygame'). */
  game?: string;
  /** Platform ID for the pre-configured entry (default: 'amiga'). */
  platform?: string;
  /** Human-readable game name (default: derived from game ID). */
  displayName?: string;
  /** Include the asset viewer tool. */
  viewer?: boolean;
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

  for (const dir of [
    '',
    'docs',
    'src/data',
    'src/engine',
    'data/' + game + '/' + platform,
    'tools/shared/__tests__',
    'tools/' + game,
    ...(viewer ? ['tools/viewer'] : []),
  ]) {
    mkdirSync(resolve(targetDir, dir), { recursive: true });
  }

  const p = (rel: string) => resolve(targetDir, rel);
  const ctx = { game, platform, displayName };

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

  // ── Viewer (optional) ──────────────────────────────────────────────

  if (viewer) {
    write(p('tools/viewer/index.html'), renderTemplate('tools/viewer/index.html.eta', ctx));
    write(p('tools/viewer/viewer.ts'), renderTemplate('tools/viewer/viewer.ts.eta', ctx));
    write(p('tools/viewer/viewer.css'), renderTemplate('tools/viewer/viewer.css.eta', ctx));
    write(p('tools/viewer/shared.ts'), renderTemplate('tools/viewer/shared.ts.eta', ctx));
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

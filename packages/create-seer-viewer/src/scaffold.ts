/**
 * create-seer-viewer — scaffolds the standalone offline asset viewer tool.
 *
 * Extracted out of create-seer so the viewer can be scaffolded (or
 * re-scaffolded/updated) independently of a full seer project.
 *
 * Run via: npx create-seer-viewer <dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';

export interface ViewerContext {
  /** Game ID for the default game/platform selection (default: 'mygame'). */
  game?: string;
  /** Platform ID for the default game/platform selection (default: 'amiga'). */
  platform?: string;
  /** Human-readable game name shown in the viewer header (default: derived from game ID). */
  displayName?: string;
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
 * Scaffold the asset viewer at `targetDir` (typically `<project>/tools/viewer`).
 * Uses Eta templates from the templates/ directory.
 */
export function scaffoldViewer(targetDir: string, ctx: ViewerContext = {}): void {
  const game = ctx.game ?? 'mygame';
  const platform = ctx.platform ?? 'amiga';
  const displayName = ctx.displayName ?? capitalize(game);

  mkdirSync(targetDir, { recursive: true });
  const p = (rel: string) => resolve(targetDir, rel);
  const data = { game, platform, displayName };

  write(p('index.html'), renderTemplate('index.html.eta', data));
  write(p('viewer.ts'), renderTemplate('viewer.ts.eta', data));
  write(p('viewer.css'), renderTemplate('viewer.css.eta', data));
  write(p('shared.ts'), renderTemplate('shared.ts.eta', data));
  write(p('data-view.ts'), renderTemplate('data-view.ts.eta', data));
}

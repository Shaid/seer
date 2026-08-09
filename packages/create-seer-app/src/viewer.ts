/**
 * Scaffolds the standalone offline asset viewer tool.
 *
 * Usable on its own (`create-seer-app viewer tools/viewer`) so an existing
 * project can gain a viewer, or be re-scaffolded, without touching anything
 * else — that is how the real consuming projects picked one up.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { capitalize, rendererFor, write } from './render.js';

export interface ViewerContext {
  /** Game ID for the default game/platform selection (default: 'mygame'). */
  game?: string;
  /** Platform ID for the default game/platform selection (default: 'amiga'). */
  platform?: string;
  /** Human-readable game name shown in the viewer header (default: derived from game ID). */
  displayName?: string;
}

const render = rendererFor('viewer');

/** Scaffold the asset viewer at `targetDir` (typically `<project>/tools/viewer`). */
export function scaffoldViewer(targetDir: string, ctx: ViewerContext = {}): void {
  const game = ctx.game ?? 'mygame';
  const platform = ctx.platform ?? 'amiga';
  const displayName = ctx.displayName ?? capitalize(game);

  mkdirSync(targetDir, { recursive: true });
  const p = (rel: string) => resolve(targetDir, rel);
  const data = { game, platform, displayName };

  write(p('index.html'), render('index.html.eta', data));
  write(p('viewer.ts'), render('viewer.ts.eta', data));
  write(p('viewer.css'), render('viewer.css.eta', data));
  write(p('shared.ts'), render('shared.ts.eta', data));
  write(p('data-view.ts'), render('data-view.ts.eta', data));
}

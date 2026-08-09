import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { scaffoldViewer, type ViewerContext } from '../scaffold.ts';

const TMP = resolve(process.cwd(), 'packages/create-seer-viewer/src/__tests__/__out__');

function run(targetDir: string, ctx: ViewerContext = {}): void {
  scaffoldViewer(resolve(TMP, targetDir), ctx);
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('scaffoldViewer', () => {
  it('creates the five viewer files', () => {
    run('basic');
    const dir = resolve(TMP, 'basic');
    expect(existsSync(resolve(dir, 'index.html'))).toBe(true);
    expect(existsSync(resolve(dir, 'viewer.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'viewer.css'))).toBe(true);
    expect(existsSync(resolve(dir, 'shared.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'data-view.ts'))).toBe(true);
  });

  it('seeds data-view.ts with an empty per-game table list keyed by the scaffolded game id', () => {
    run('data-view-default');
    const ts = readFileSync(resolve(TMP, 'data-view-default/data-view.ts'), 'utf-8');
    expect(ts).toContain("'mygame': [],");
  });

  it('uses defaults when no context is provided', () => {
    run('defaults');
    const html = readFileSync(resolve(TMP, 'defaults/index.html'), 'utf-8');
    expect(html).toContain('Mygame');
    const ts = readFileSync(resolve(TMP, 'defaults/viewer.ts'), 'utf-8');
    expect(ts).toContain("currentGame = 'mygame'");
    expect(ts).toContain("currentPlatform = 'amiga'");
  });

  it('renders the game/platform/displayName context into templates', () => {
    run('custom', { game: 'foobar', platform: 'dos', displayName: 'Foo Bar' });
    const html = readFileSync(resolve(TMP, 'custom/index.html'), 'utf-8');
    expect(html).toContain('Foo Bar');
    const ts = readFileSync(resolve(TMP, 'custom/viewer.ts'), 'utf-8');
    expect(ts).toContain("currentGame = 'foobar'");
    expect(ts).toContain("currentPlatform = 'dos'");
  });

  it('derives displayName from game ID when not given', () => {
    run('derived', { game: 'testgame' });
    const html = readFileSync(resolve(TMP, 'derived/index.html'), 'utf-8');
    expect(html).toContain('Testgame');
  });

  it('creates the target directory if missing', () => {
    run('nested/dir/viewer');
    expect(existsSync(resolve(TMP, 'nested/dir/viewer/index.html'))).toBe(true);
  });
});

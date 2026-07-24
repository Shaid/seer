import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { scaffold, type ScaffoldOptions } from '../scaffold.ts';

const TMP = resolve(process.cwd(), 'packages/create-seer/src/__tests__/__out__');

function run(targetDir: string, options: ScaffoldOptions = {}): void {
  scaffold(resolve(TMP, targetDir), options);
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('scaffold', () => {
  it('creates root config files', () => {
    run('config-files');
    const dir = resolve(TMP, 'config-files');
    expect(existsSync(resolve(dir, 'package.json'))).toBe(true);
    expect(existsSync(resolve(dir, 'tsconfig.json'))).toBe(true);
    expect(existsSync(resolve(dir, 'vite.config.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'eslint.config.js'))).toBe(true);
    expect(existsSync(resolve(dir, 'index.html'))).toBe(true);
    expect(existsSync(resolve(dir, '.gitignore'))).toBe(true);
    expect(existsSync(resolve(dir, 'seer.config.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'README.md'))).toBe(true);
    expect(existsSync(resolve(dir, '.prettierrc'))).toBe(true);
  });

  it('creates src/ files and directories', () => {
    run('src-dir');
    const dir = resolve(TMP, 'src-dir');
    expect(existsSync(resolve(dir, 'src/game-id.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'src/main.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'src/data/GameData.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'src/data/AssetLoader.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'src/data'))).toBe(true);
    expect(existsSync(resolve(dir, 'src/engine'))).toBe(true);
  });

  it('creates tools/ files and directories', () => {
    run('tools-dir');
    const dir = resolve(TMP, 'tools-dir');
    expect(existsSync(resolve(dir, 'tools/shared/game-config.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'tools/shared/__tests__/game-config.test.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'tools/extract-game-data.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'tools/mygame/export-game-data.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'tools/mygame/build-assets.ts'))).toBe(true);
  });

  it('creates the game data directory', () => {
    run('data-dir');
    expect(existsSync(resolve(TMP, 'data-dir/data/mygame/amiga'))).toBe(true);
  });

  it('accepts a custom game ID', () => {
    run('custom-game', { game: 'foobar' });
    expect(existsSync(resolve(TMP, 'custom-game/data/foobar/amiga'))).toBe(true);
    expect(existsSync(resolve(TMP, 'custom-game/tools/foobar/export-game-data.ts'))).toBe(true);
    expect(existsSync(resolve(TMP, 'custom-game/tools/foobar/build-assets.ts'))).toBe(true);
  });

  it('accepts a custom platform ID', () => {
    run('custom-platform', { platform: 'dos' });
    expect(existsSync(resolve(TMP, 'custom-platform/data/mygame/dos'))).toBe(true);
  });

  it('uses the displayName option in package.json', () => {
    run('display-name', { displayName: 'My Awesome Game' });
    const pkg = readFileSync(resolve(TMP, 'display-name/package.json'), 'utf-8');
    expect(pkg).toContain('"name": "mygame"');
  });

  it('derives displayName from game ID when not given', () => {
    run('derived-name', { game: 'testgame' });
    const pkg = readFileSync(resolve(TMP, 'derived-name/package.json'), 'utf-8');
    expect(pkg).toContain('"name": "testgame"');
  });

  it('creates documentation files', () => {
    run('docs-test');
    const dir = resolve(TMP, 'docs-test');
    expect(existsSync(resolve(dir, 'docs/architecture-overview.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'docs/boilerplate-guide.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'docs/framework-plan.md'))).toBe(true);
    const readme = readFileSync(resolve(dir, 'README.md'), 'utf-8');
    expect(readme).toContain('docs/architecture-overview.md');
    expect(readme).not.toContain('github.com/Shaid/seer');
  });

  it('renders templates with the context variables', () => {
    run('template-vars', { game: 'demo', platform: 'amiga' });
    const pkg = readFileSync(resolve(TMP, 'template-vars/package.json'), 'utf-8');
    expect(pkg).toContain('"name": "demo"');
    const main = readFileSync(resolve(TMP, 'template-vars/src/main.ts'), 'utf-8');
    expect(main).toContain("from '@seer/engine'");
  });

  it('creates viewer files when viewer option is true', () => {
    run('with-viewer', { viewer: true });
    const dir = resolve(TMP, 'with-viewer');
    expect(existsSync(resolve(dir, 'tools/viewer/index.html'))).toBe(true);
    expect(existsSync(resolve(dir, 'tools/viewer/viewer.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'tools/viewer/viewer.css'))).toBe(true);
    expect(existsSync(resolve(dir, 'tools/viewer/shared.ts'))).toBe(true);
  });

  it('does not create viewer files when viewer is false', () => {
    run('no-viewer', { viewer: false });
    expect(existsSync(resolve(TMP, 'no-viewer/tools/viewer'))).toBe(false);
  });

  it('uses defaults when no options are provided', () => {
    run('defaults');
    expect(existsSync(resolve(TMP, 'defaults/data/mygame/amiga'))).toBe(true);
    expect(existsSync(resolve(TMP, 'defaults/tools/mygame/export-game-data.ts'))).toBe(true);
  });
});

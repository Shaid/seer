import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { scaffold, type ScaffoldOptions } from '../project.js';

const TMP = resolve(process.cwd(), 'packages/create-seer-app/src/__tests__/__out__/project');

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

  it('links out to the framework docs instead of vendoring stale copies', () => {
    run('docs-test');
    const dir = resolve(TMP, 'docs-test');
    // architecture-overview.md and boilerplate-guide.md used to be vendored
    // verbatim into every scaffolded project (docs/*.eta, no template
    // variables) and linked locally. docs/common-tooling-candidates.md §15a
    // flagged that as a real problem — three sibling repos carried
    // byte-identical stale copies, one a 57-line-stale fork, and none would
    // ever receive a framework update. All three framework docs now follow
    // the same link-not-copy pattern viewer.md set the precedent for: no
    // local `docs/` directory is created at all, and README.md links out to
    // GitHub for all three.
    expect(existsSync(resolve(dir, 'docs'))).toBe(false);
    const readme = readFileSync(resolve(dir, 'README.md'), 'utf-8');
    expect(readme).toContain('github.com/Shaid/seer/blob/main/docs/architecture-overview.md');
    expect(readme).toContain('github.com/Shaid/seer/blob/main/docs/boilerplate-guide.md');
    expect(readme).toContain('github.com/Shaid/seer/blob/main/docs/viewer.md');
  });

  it('writes file: paths to seer packages in package.json', () => {
    run('seer-paths');
    const dir = resolve(TMP, 'seer-paths');
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8'));
    for (const dep of ['@seer-project/core', '@seer-project/engine-2d', '@seer-project/pipeline']) {
      const spec = pkg.dependencies[dep] as string;
      expect(spec).toMatch(/^file:/);
      const target = resolve(dir, spec.slice('file:'.length));
      expect(existsSync(target)).toBe(true);
      const targetPkg = JSON.parse(readFileSync(resolve(target, 'package.json'), 'utf-8'));
      expect(targetPkg.name).toBe(dep);
    }
  });

  it('renders templates with the context variables', () => {
    run('template-vars', { game: 'demo', platform: 'amiga' });
    const pkg = readFileSync(resolve(TMP, 'template-vars/package.json'), 'utf-8');
    expect(pkg).toContain('"name": "demo"');
    const main = readFileSync(resolve(TMP, 'template-vars/src/main.ts'), 'utf-8');
    expect(main).toContain("from './game-id.ts'");
  });

  it('creates viewer files when viewer option is true', () => {
    run('with-viewer', { viewer: true });
    const dir = resolve(TMP, 'with-viewer');
    expect(existsSync(resolve(dir, 'tools/viewer/index.html'))).toBe(true);
    expect(existsSync(resolve(dir, 'tools/viewer/viewer.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'tools/viewer/viewer.css'))).toBe(true);
    expect(existsSync(resolve(dir, 'tools/viewer/shared.ts'))).toBe(true);
    // The placeholder splash only links to the viewer when it's scaffolded.
    const main = readFileSync(resolve(dir, 'src/main.ts'), 'utf-8');
    expect(main).toContain('/tools/viewer/');
  });

  it('does not create viewer files when viewer is false', () => {
    run('no-viewer', { viewer: false });
    expect(existsSync(resolve(TMP, 'no-viewer/tools/viewer'))).toBe(false);
    // The splash must not link to a viewer that wasn't scaffolded.
    const main = readFileSync(resolve(TMP, 'no-viewer/src/main.ts'), 'utf-8');
    expect(main).not.toContain('/tools/viewer/');
  });

  it('uses defaults when no options are provided', () => {
    run('defaults');
    expect(existsSync(resolve(TMP, 'defaults/data/mygame/amiga'))).toBe(true);
    expect(existsSync(resolve(TMP, 'defaults/tools/mygame/export-game-data.ts'))).toBe(true);
  });

  it('creates a docs site (delegated to create-seer-website) when docsSite is true', () => {
    run('with-docs-site', { docsSite: true, game: 'demo' });
    const dir = resolve(TMP, 'with-docs-site');
    expect(existsSync(resolve(dir, 'www/package.json'))).toBe(true);
    expect(existsSync(resolve(dir, 'www/astro.config.mjs'))).toBe(true);
    expect(existsSync(resolve(dir, 'www/src/content/docs/demo/index.mdx'))).toBe(true);
    expect(existsSync(resolve(dir, '.github/workflows/deploy.yml'))).toBe(true);
  });

  it('does not create a docs site when docsSite is false', () => {
    run('no-docs-site', { docsSite: false });
    expect(existsSync(resolve(TMP, 'no-docs-site/www'))).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
}));

const TMP = resolve(process.cwd(), 'packages/create-seer-website/src/__tests__/__cli_out__');

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('parseFlags', () => {
  it('extracts --game and --display-name', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags(['node', 'seer', 'www', '--game', 'mygame', '--display-name', 'My Game']);
    expect(result).toEqual({ game: 'mygame', displayName: 'My Game' });
  });

  it('extracts --description and --site', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags(['node', 'seer', 'www', '--description', 'Desc', '--site', 'https://x.example']);
    expect(result).toEqual({ description: 'Desc', site: 'https://x.example' });
  });

  it('extracts favicon flags', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags([
      'node', 'seer', 'www',
      '--favicon-frame', 'item042',
      '--favicon-atlas-dir', 'amiga/sprites',
      '--favicon-manifest', 'items.json',
    ]);
    expect(result).toEqual({
      faviconFrame: 'item042',
      faviconAtlasDir: 'amiga/sprites',
      faviconManifest: 'items.json',
    });
  });

  it('returns empty object when no flags given', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags(['node', 'seer', 'www']);
    expect(result).toEqual({});
  });
});

describe('promptOrFallback', () => {
  it('returns default when not a TTY', async () => {
    const { promptOrFallback } = await import('../cli.ts');
    const result = await promptOrFallback('Game ID', { default: 'mygame' }, false);
    expect(result).toBe('mygame');
  });
});

describe('main', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('exits with error when no target directory and not a TTY', async () => {
    const { main } = await import('../cli.ts');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['node', 'seer']);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('target directory is required'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('scaffolds with flags and no TTY', async () => {
    const { main } = await import('../cli.ts');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const targetDir = resolve(TMP, 'flags-test/www');
    const origCwd = process.cwd;
    process.cwd = () => TMP;

    await main(['node', 'seer', 'flags-test/www', '--game', 'testg', '--display-name', 'TestG']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(existsSync(resolve(targetDir, 'package.json'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'src/content/docs/testg/index.mdx'))).toBe(true);

    process.cwd = origCwd;
  });

  it('uses defaults for missing optional flags when not a TTY', async () => {
    const { main } = await import('../cli.ts');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const targetDir = resolve(TMP, 'defaults-test/www');
    const origCwd = process.cwd;
    process.cwd = () => TMP;

    await main(['node', 'seer', 'defaults-test/www']);

    expect(exitSpy).not.toHaveBeenCalled();
    const pkg = await import('node:fs').then((m) => m.readFileSync(resolve(targetDir, 'package.json'), 'utf-8'));
    expect(pkg).toContain('"name": "mygame-www"');

    process.cwd = origCwd;
  });
});

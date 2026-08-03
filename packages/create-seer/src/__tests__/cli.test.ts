import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
}));

const TMP = resolve(process.cwd(), 'packages/create-seer/src/__tests__/__cli_out__');

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('parseFlags', () => {
  it('extracts --game and --platform', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags(['node', 'seer', 'my-game', '--game', 'mygame', '--platform', 'amiga']);
    expect(result).toEqual({ game: 'mygame', platform: 'amiga' });
  });

  it('extracts --display-name', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags(['node', 'seer', 'my-game', '--display-name', 'My Game']);
    expect(result).toEqual({ displayName: 'My Game' });
  });

  it('sets viewer to true when --viewer is present', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags(['node', 'seer', 'my-game', '--viewer']);
    expect(result).toEqual({ viewer: true });
  });

  it('sets docsSite to true when --docs-site is present', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags(['node', 'seer', 'my-game', '--docs-site']);
    expect(result).toEqual({ docsSite: true });
  });

  it('returns empty object when no flags given', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags(['node', 'seer', 'my-game']);
    expect(result).toEqual({});
  });
});

describe('promptOrFallback', () => {
  it('returns default when not a TTY', async () => {
    const { promptOrFallback } = await import('../cli.ts');
    const result = await promptOrFallback('Game ID', { default: 'mygame' }, false);
    expect(result).toBe('mygame');
  });

  it('returns empty string when no default and not a TTY', async () => {
    const { promptOrFallback } = await import('../cli.ts');
    const result = await promptOrFallback('Name', {}, false);
    expect(result).toBe('');
  });
});

describe('confirmOrFallback', () => {
  it('returns false when not a TTY', async () => {
    const { confirmOrFallback } = await import('../cli.ts');
    const result = await confirmOrFallback('Include viewer?', false);
    expect(result).toBe(false);
  });
});

describe('main', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('exits with error when no project name and not a TTY', async () => {
    const { main } = await import('../cli.ts');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['node', 'seer']);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('project name is required'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('scaffolds with flags and no TTY', async () => {
    const { main } = await import('../cli.ts');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const projectDir = resolve(TMP, 'flags-test');
    const origCwd = process.cwd;
    process.cwd = () => TMP;

    await main(['node', 'seer', 'flags-test', '--game', 'testg', '--platform', 'amiga', '--display-name', 'TestG']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(existsSync(resolve(projectDir, 'package.json'))).toBe(true);
    expect(existsSync(resolve(projectDir, 'src/main.ts'))).toBe(true);
    expect(existsSync(resolve(projectDir, 'data/testg/amiga'))).toBe(true);

    const pkg = JSON.parse(await import('node:fs').then(m => m.readFileSync(resolve(projectDir, 'package.json'), 'utf-8')));
    expect(pkg.name).toBe('testg');

    process.cwd = origCwd;
  });

  it('scaffolds a docs site when --docs-site is passed', async () => {
    const { main } = await import('../cli.ts');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const projectDir = resolve(TMP, 'docs-site-test');
    const origCwd = process.cwd;
    process.cwd = () => TMP;

    await main(['node', 'seer', 'docs-site-test', '--game', 'testg', '--docs-site']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(existsSync(resolve(projectDir, 'www/package.json'))).toBe(true);
    expect(existsSync(resolve(projectDir, '.github/workflows/deploy.yml'))).toBe(true);

    process.cwd = origCwd;
  });

  it('exits when target directory already exists', async () => {
    const dir = resolve(TMP, 'exists-test');
    mkdirSync(dir, { recursive: true });

    const { main } = await import('../cli.ts');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const origCwd = process.cwd;
    process.cwd = () => TMP;

    await main(['node', 'seer', 'exists-test', '--game', 'g', '--platform', 'p']);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    process.cwd = origCwd;
  });

  it('uses defaults for missing optional flags when not a TTY', async () => {
    const { main } = await import('../cli.ts');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const projectDir = resolve(TMP, 'defaults-test');
    const origCwd = process.cwd;
    process.cwd = () => TMP;

    await main(['node', 'seer', 'defaults-test']);

    expect(exitSpy).not.toHaveBeenCalled();
    const pkg = JSON.parse(await import('node:fs').then(m => m.readFileSync(resolve(projectDir, 'package.json'), 'utf-8')));
    expect(pkg.name).toBe('mygame');

    process.cwd = origCwd;
  });
});

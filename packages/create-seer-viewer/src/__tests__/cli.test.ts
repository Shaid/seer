import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
}));

const TMP = resolve(process.cwd(), 'packages/create-seer-viewer/src/__tests__/__cli_out__');

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('parseFlags', () => {
  it('extracts --game and --platform', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags(['node', 'seer', 'tools/viewer', '--game', 'mygame', '--platform', 'amiga']);
    expect(result).toEqual({ game: 'mygame', platform: 'amiga' });
  });

  it('extracts --display-name', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags(['node', 'seer', 'tools/viewer', '--display-name', 'My Game']);
    expect(result).toEqual({ displayName: 'My Game' });
  });

  it('returns empty object when no flags given', async () => {
    const { parseFlags } = await import('../cli.ts');
    const result = parseFlags(['node', 'seer', 'tools/viewer']);
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

    const targetDir = resolve(TMP, 'flags-test');
    const origCwd = process.cwd;
    process.cwd = () => TMP;

    await main(['node', 'seer', 'flags-test', '--game', 'testg', '--platform', 'amiga', '--display-name', 'TestG']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(existsSync(resolve(targetDir, 'index.html'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'viewer.ts'))).toBe(true);

    process.cwd = origCwd;
  });

  it('uses defaults for missing optional flags when not a TTY', async () => {
    const { main } = await import('../cli.ts');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const targetDir = resolve(TMP, 'defaults-test');
    const origCwd = process.cwd;
    process.cwd = () => TMP;

    await main(['node', 'seer', 'defaults-test']);

    expect(exitSpy).not.toHaveBeenCalled();
    const html = await import('node:fs').then((m) => m.readFileSync(resolve(targetDir, 'index.html'), 'utf-8'));
    expect(html).toContain('Mygame');

    process.cwd = origCwd;
  });
});

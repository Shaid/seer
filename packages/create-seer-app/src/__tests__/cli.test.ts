import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from '../cli.js';

const TMP = resolve(process.cwd(), 'packages/create-seer-app/src/__tests__/__out__/cli');

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('parseArgs', () => {
  it('defaults to project mode with no subcommand', () => {
    expect(parseArgs(['node', 'x', 'my-project'])).toMatchObject({
      mode: 'project',
      targetDir: 'my-project',
    });
  });

  it('recognises the viewer and website subcommands', () => {
    expect(parseArgs(['node', 'x', 'viewer', 'tools/viewer'])).toMatchObject({
      mode: 'viewer',
      targetDir: 'tools/viewer',
    });
    expect(parseArgs(['node', 'x', 'website', 'www'])).toMatchObject({
      mode: 'website',
      targetDir: 'www',
    });
  });

  // Regression: the previous implementation sliced argv at a fixed index, so
  // flags placed before the target were dropped entirely *and* the flag name
  // itself became the target directory.
  it('parses flags before or after the target directory', () => {
    const after = parseArgs(['node', 'x', 'mydir', '--game', 'foo']);
    const before = parseArgs(['node', 'x', '--game', 'foo', 'mydir']);

    expect(after.targetDir).toBe('mydir');
    expect(after.flags.game).toBe('foo');
    expect(before.targetDir).toBe('mydir');
    expect(before.flags.game).toBe('foo');
    expect(before).toEqual(after);
  });

  it('keeps flag order-insensitivity for subcommands too', () => {
    const parsed = parseArgs(['node', 'x', '--game', 'zonx', 'website', 'www']);
    expect(parsed).toMatchObject({ mode: 'website', targetDir: 'www' });
    expect(parsed.flags.game).toBe('zonx');
  });

  it('handles boolean flags and their --no- forms', () => {
    expect(parseArgs(['node', 'x', 'd', '--viewer', '--docs-site']).flags).toMatchObject({
      viewer: true,
      docsSite: true,
    });
    expect(parseArgs(['node', 'x', 'd', '--no-viewer', '--no-docs-site']).flags).toMatchObject({
      viewer: false,
      docsSite: false,
    });
  });

  it('reports a flag whose value is missing rather than swallowing it', () => {
    expect(parseArgs(['node', 'x', 'd', '--game']).unknown).toContain('--game (missing value)');
    expect(parseArgs(['node', 'x', 'd', '--game', '--viewer']).unknown).toContain(
      '--game (missing value)',
    );
  });

  it('collects unrecognised flags', () => {
    expect(parseArgs(['node', 'x', 'd', '--nope']).unknown).toEqual(['--nope']);
  });
});

describe('main', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('exits with an error when no target directory and not a TTY', async () => {
    const { main } = await import('../cli.js');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['node', 'x']);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('target directory is required'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects unrecognised arguments', async () => {
    const { main } = await import('../cli.js');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['node', 'x', 'somewhere', '--bogus']);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('unrecognised argument'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Regression: all three previous CLIs prompted for the target directory,
  // validated the answer, then resolved the *unset* argv value instead —
  // scaffolding into the cwd rather than where the user asked.
  it('scaffolds into the directory the interactive prompt returned', async () => {
    const named = resolve(TMP, 'prompted-dir');
    vi.doMock('@inquirer/prompts', () => ({
      input: vi.fn(async ({ message }: { message: string }) =>
        message === 'Site directory' ? named : '',
      ),
      confirm: vi.fn(async () => false),
    }));
    // `process.stdout.isTTY` is absent (not merely false) off a terminal, so
    // there is no getter to spy on — define the property for this test.
    const hadIsTTY = 'isTTY' in process.stdout;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    try {
      const { main } = await import('../cli.js');
      await main(['node', 'x', 'website']);
    } finally {
      if (hadIsTTY)
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }

    expect(existsSync(resolve(named, 'astro.config.mjs'))).toBe(true);
    // ...and specifically NOT into the current working directory.
    expect(existsSync(resolve(process.cwd(), 'astro.config.mjs'))).toBe(false);
  });

  it('scaffolds a website with flags and no TTY', async () => {
    const { main } = await import('../cli.js');
    const target = resolve(TMP, 'flagged');

    await main(['node', 'x', 'website', target, '--game', 'testg', '--display-name', 'TestG']);

    expect(existsSync(resolve(target, 'astro.config.mjs'))).toBe(true);
    expect(existsSync(resolve(target, 'src/content/docs/testg/index.mdx'))).toBe(true);
  });

  it('scaffolds a viewer with flags and no TTY', async () => {
    const { main } = await import('../cli.js');
    const target = resolve(TMP, 'viewer-flagged');

    await main(['node', 'x', 'viewer', target, '--game', 'testg', '--platform', 'dosvga']);

    expect(existsSync(resolve(target, 'viewer.ts'))).toBe(true);
    expect(existsSync(resolve(target, 'index.html'))).toBe(true);
  });
});

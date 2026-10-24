import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCheckpoint } from '../checkpoint.js';

const root = mkdtempSync(join(tmpdir(), 'seer-checkpoint-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
let dir: string;
beforeEach(() => {
  dir = join(root, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
});

describe('openCheckpoint — on-disk format', () => {
  // The format is a compatibility contract, not an implementation detail:
  // checkpoint files written by the hand-rolled loops this replaces are real
  // build state sitting in projects' output trees, and must keep resuming.
  it('writes JSON.stringify of the set, in insertion order', () => {
    const log = openCheckpoint<string>(dir, '.progress');
    log.mark('b/second.bin');
    log.mark('a/first.bin');
    expect(readFileSync(join(dir, '.progress'), 'utf8')).toBe(
      JSON.stringify(['b/second.bin', 'a/first.bin']),
    );
  });

  it('round-trips numeric keys (the archive-index stages) without stringifying them', () => {
    const log = openCheckpoint<number>(dir, '.meshProgress');
    log.mark(12);
    log.mark(4);
    expect(readFileSync(join(dir, '.meshProgress'), 'utf8')).toBe('[12,4]');
    const reopened = openCheckpoint<number>(dir, '.meshProgress');
    expect(reopened.has(12)).toBe(true);
    expect(reopened.has(4)).toBe(true);
    expect(reopened.has(5)).toBe(false);
    expect(reopened.size).toBe(2);
  });

  it('resumes from a file written by a hand-rolled predecessor', () => {
    writeFileSync(join(dir, '.audioProgress.json'), JSON.stringify(['nx/sound/a.bin', 'nx/sound/b.bin']));
    const log = openCheckpoint<string>(dir, '.audioProgress.json');
    expect(log.size).toBe(2);
    expect(log.has('nx/sound/a.bin')).toBe(true);
  });

  // A stage that throws on a truncated checkpoint can never be restarted
  // without someone deleting the file by hand — which is the opposite of
  // what the file is for.
  it('treats a corrupt file as nothing-done-yet rather than throwing', () => {
    writeFileSync(join(dir, '.progress'), 'not json at all');
    const log = openCheckpoint<string>(dir, '.progress');
    expect(log.size).toBe(0);
  });

  it('starts empty when the file is absent and writes nothing until asked', () => {
    const log = openCheckpoint<string>(dir, '.progress');
    expect(log.size).toBe(0);
    expect(existsSync(join(dir, '.progress'))).toBe(false);
  });

  it('passes `filename` through verbatim, suffix and all', () => {
    openCheckpoint<number>(dir, '.sfxProgress.json').mark(1);
    expect(existsSync(join(dir, '.sfxProgress.json'))).toBe(true);
    expect(existsSync(join(dir, '.sfxProgress.json.json'))).toBe(false);
  });
});

describe('openCheckpoint — flush cadence', () => {
  it('add() stays in memory; flush() writes', () => {
    const log = openCheckpoint<number>(dir, '.animationProgress');
    log.add(1);
    log.add(2);
    expect(existsSync(join(dir, '.animationProgress'))).toBe(false);
    log.flush();
    expect(readFileSync(join(dir, '.animationProgress'), 'utf8')).toBe('[1,2]');
  });

  it('mark() is add-then-flush', () => {
    const log = openCheckpoint<number>(dir, '.p');
    log.mark(7);
    expect(readFileSync(join(dir, '.p'), 'utf8')).toBe('[7]');
  });

  it('re-adding a key neither duplicates it nor grows the file', () => {
    const log = openCheckpoint<string>(dir, '.p');
    log.mark('x');
    log.mark('x');
    expect(log.size).toBe(1);
    expect(readFileSync(join(dir, '.p'), 'utf8')).toBe('["x"]');
  });
});

describe('openCheckpoint — load / persist', () => {
  it('load: false ignores the existing file (the --force path) but still persists', () => {
    writeFileSync(join(dir, '.voiceLineProgress'), JSON.stringify([1, 2, 3]));
    const log = openCheckpoint<number>(dir, '.voiceLineProgress', { load: false });
    expect(log.size).toBe(0);
    log.mark(9);
    expect(readFileSync(join(dir, '.voiceLineProgress'), 'utf8')).toBe('[9]');
  });

  // The --only path: a run over a hand-picked subset is not a complete run,
  // so it must not be able to overwrite the real checkpoint with its own
  // much smaller set.
  it('persist: false never touches the file (the --only path)', () => {
    writeFileSync(join(dir, '.meshProgress'), JSON.stringify([1, 2, 3]));
    const log = openCheckpoint<number>(dir, '.meshProgress', { load: false, persist: false });
    log.mark(99);
    log.flush();
    expect(log.has(99)).toBe(true);
    expect(readFileSync(join(dir, '.meshProgress'), 'utf8')).toBe(JSON.stringify([1, 2, 3]));
  });
});

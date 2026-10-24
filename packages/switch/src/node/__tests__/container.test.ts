/**
 * The on-disk half: listing an NSP's PFS0 without reading the file, and
 * carving one entry back out byte for byte.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listPfs0File, extractFileRange } from '../container.js';
import { buildPfs0, FIXTURE_BASE, FIXTURE_FILES, META, PROGRAM } from '../../__tests__/pfs0-fixture.js';

let dir: string;
let nspPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'seer-pfs0-'));
  nspPath = join(dir, 'fake.nsp');
  writeFileSync(nspPath, buildPfs0(FIXTURE_FILES));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('listPfs0File', () => {
  it('reads every entry with an absolute offset', () => {
    const entries = listPfs0File(nspPath);
    expect(entries.map((e) => e.name)).toEqual(['abc.cnmt.nca', 'def.nca']);
    expect(entries.map((e) => e.size)).toEqual([META.length, PROGRAM.length]);
    expect(entries.map((e) => e.absOffset)).toEqual([FIXTURE_BASE, FIXTURE_BASE + META.length]);
  });

  it('names the path when the file is not a PFS0', () => {
    const notNsp = join(dir, 'not.nsp');
    writeFileSync(notNsp, Buffer.from('HFS0....................', 'utf8'));
    expect(() => listPfs0File(notNsp)).toThrow(/not\.nsp: not a PFS0 \(HFS0\)/);
  });
});

describe('extractFileRange', () => {
  it('carves the named entry out byte for byte', () => {
    const program = listPfs0File(nspPath).find((e) => e.name === 'def.nca')!;
    const out = join(dir, 'carved.nca');
    extractFileRange(nspPath, out, program.absOffset, program.size);
    expect(new Uint8Array(readFileSync(out))).toEqual(PROGRAM);
  });
});

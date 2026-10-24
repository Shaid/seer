/**
 * PFS0 entry-table walk, against a synthetic two-file partition built byte
 * by byte in `pfs0-fixture.ts`.
 *
 * The invariant that matters is that entry offsets come back *absolute* —
 * the data base added — because the stored value is relative and nothing
 * downstream can tell the difference until an NCA fails to decrypt.
 */
import { describe, it, expect } from 'vitest';

import { PFS0_HEADER_SIZE, parsePfs0, parsePfs0Header, pfs0HeaderLength } from '../pfs0.js';
import { buildPfs0, FIXTURE_BASE, FIXTURE_FILES, META, PROGRAM } from './pfs0-fixture.js';

const NSP = buildPfs0(FIXTURE_FILES);

describe('parsePfs0Header', () => {
  it('sizes the header region from the counts, including string-table padding', () => {
    expect(parsePfs0Header(NSP)).toEqual({
      entryCount: 2,
      stringTableSize: 0x20,
      headerLength: FIXTURE_BASE,
    });
    expect(pfs0HeaderLength(NSP.subarray(0, PFS0_HEADER_SIZE))).toBe(FIXTURE_BASE);
  });

  it('rejects a container that is not a PFS0, naming the magic it found', () => {
    const hfs0 = Uint8Array.from('HFS0............', (c) => c.charCodeAt(0));
    expect(() => parsePfs0Header(hfs0)).toThrow(/not a PFS0 \(HFS0\)/);
  });

  it('rejects a header shorter than the fixed 0x10 bytes', () => {
    expect(() => parsePfs0Header(NSP.subarray(0, 8))).toThrow(/truncated header/);
  });
});

describe('parsePfs0', () => {
  it('reads every entry name and size', () => {
    const entries = parsePfs0(NSP);
    expect(entries.map((e) => e.name)).toEqual(['abc.cnmt.nca', 'def.nca']);
    expect(entries.map((e) => e.size)).toEqual([META.length, PROGRAM.length]);
  });

  it('returns offsets absolute within the container, not relative to the data base', () => {
    const entries = parsePfs0(NSP);
    expect(entries[0]!.absOffset).toBe(FIXTURE_BASE);
    expect(entries[1]!.absOffset).toBe(FIXTURE_BASE + META.length);
    const second = entries[1]!;
    expect(NSP.subarray(second.absOffset, second.absOffset + second.size)).toEqual(PROGRAM);
  });

  it('needs only the header region, not the file data', () => {
    expect(parsePfs0(NSP.subarray(0, FIXTURE_BASE))).toEqual(parsePfs0(NSP));
  });

  it('refuses a buffer that stops inside the header region rather than inventing names', () => {
    expect(() => parsePfs0(NSP.subarray(0, FIXTURE_BASE - 1))).toThrow(/header region needs/);
  });
});

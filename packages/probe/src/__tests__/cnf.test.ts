import { describe, it, expect } from 'vitest';
import { buildHunkExe } from '@seer-project/amiga';
import { auditCnf, carveIslands, dcxRatio, generateCnf, parseCnf } from '../cnf.js';
import { parseHunkFile } from '@seer-project/amiga';

/** CODE payload: NOP sled + a planted string table + a zero run + more NOPs. */
function makeCodePayload(): { payload: Uint8Array; stringStart: number; stringEnd: number; zeroStart: number; zeroEnd: number } {
  const parts: number[] = [];
  const nops = (n: number) => {
    for (let i = 0; i < n; i++) parts.push(0x4e, 0x71);
  };
  nops(1024); // 2 KB of code, so the carved islands stay a small fraction of the hunk
  const stringStart = parts.length;
  for (const s of ['LOADING GAME DATA', 'INSERT DISK 2', 'PRESS FIRE TO CONTINUE', 'OUT OF MEMORY']) {
    for (const ch of s) parts.push(ch.charCodeAt(0));
    parts.push(0);
  }
  while ((parts.length - stringStart) % 2) parts.push(0);
  const stringEnd = parts.length;
  nops(64);
  const zeroStart = parts.length;
  for (let i = 0; i < 128; i++) parts.push(0);
  const zeroEnd = parts.length;
  nops(64);
  return { payload: Uint8Array.from(parts), stringStart, stringEnd, zeroStart, zeroEnd };
}

describe('parseCnf', () => {
  it('extracts OFFSET and CODE ranges, tolerating comments and either dash style', () => {
    const cnf = parseCnf(
      'MACHINE 68000\nENTRY $0\nOFFSET $00001000\nCODE $00000000 - $00000100 ; first\nCODE $200 $300\nEND\n',
    );
    expect(cnf.offset).toBe(0x1000);
    expect(cnf.codeRanges).toEqual([
      { start: 0, end: 0x100 },
      { start: 0x200, end: 0x300 },
    ]);
  });
});

describe('generateCnf', () => {
  const { payload, stringStart, stringEnd, zeroStart, zeroEnd } = makeCodePayload();
  const exe = buildHunkExe([
    {
      type: 'CODE',
      payload,
      symbols: [
        { name: '_main', value: 0 },
        { name: '_loader', value: 0x80 },
      ],
    },
    { type: 'BSS', memLongwords: 64 },
    { type: 'DATA', payload: new Uint8Array(32) },
  ]);
  const generated = generateCnf(exe);

  it('declares whole CODE hunks minus carved islands, with the standard prologue', () => {
    expect(generated.text).toMatch(/^MACHINE 68000\n/);
    expect(generated.text).toContain('ENTRY $00000000');
    expect(generated.text).toContain('OFFSET $00000000');
    expect(generated.text.trim().endsWith('END')).toBe(true);
    expect(generated.codeHunkCount).toBe(1);
    // First CODE range starts at 0 and runs to the first carved island.
    const firstIsland = generated.islands[0];
    expect(generated.text).toContain(
      `CODE $00000000 - $${firstIsland.start.toString(16).toUpperCase().padStart(8, '0')}`,
    );
  });

  it('carves the planted string table as TEXT and the zero run as DATA', () => {
    const text = generated.islands.find((i) => i.kind === 'string-table');
    const zero = generated.islands.find((i) => i.kind === 'zero-run');
    expect(text).toBeDefined();
    expect(zero).toBeDefined();
    expect(text!.start).toBeGreaterThanOrEqual(stringStart);
    expect(text!.end).toBeLessThanOrEqual(stringEnd);
    expect(zero!.start).toBeGreaterThanOrEqual(zeroStart);
    expect(zero!.end).toBeLessThanOrEqual(zeroEnd);
    expect(generated.text).toMatch(/^TEXT \$/m);
    expect(generated.text).toMatch(/^DATA \$/m);
  });

  it('emits HUNK_SYMBOL entries as SYMBOL directives', () => {
    expect(generated.text).toContain('SYMBOL _main $00000000');
    expect(generated.text).toContain('SYMBOL _loader $00000080');
    expect(generated.symbols).toBe(2);
  });

  it('round-trips through --audit at near-total coverage', () => {
    const audit = auditCnf(exe, generated.text, 'exe', 'gen.cnf');
    const islandBytes = generated.islands.reduce((s, i) => s + (i.end - i.start), 0);
    // Hunk payloads are longword-padded in the file; the parser reports the padded size.
    const paddedLen = Math.ceil(payload.length / 4) * 4;
    expect(audit.totalPayloadBytes).toBe(paddedLen);
    expect(audit.totalDeclaredBytes).toBe(paddedLen - islandBytes);
    expect(audit.coverage).toBeGreaterThan(0.9);
    expect(audit.assessment).toMatch(/healthy/);
  });
});

describe('generateCnf across multiple hunks', () => {
  it('addresses later CODE hunks by cumulative memory size (BSS included)', () => {
    const codeA = new Uint8Array(64).fill(0x4e);
    const codeB = new Uint8Array(32).fill(0x4e);
    const exe = buildHunkExe([
      { type: 'CODE', payload: codeA },
      { type: 'BSS', memLongwords: 0x100 }, // 0x400 bytes of address space
      { type: 'CODE', payload: codeB },
    ]);
    const generated = generateCnf(exe);
    // Hunk 2's address = 64 (hunk 0) + 0x400 (BSS) = 0x440.
    expect(generated.text).toContain('CODE $00000440 - $00000460');

    const audit = auditCnf(exe, generated.text, 'exe', 'gen.cnf');
    expect(audit.codeHunks.map((h) => h.address)).toEqual([0, 0x440]);
    expect(audit.coverage).toBe(1);
  });
});

describe('auditCnf failure-mode naming', () => {
  const payload = new Uint8Array(0x10000).fill(0x4e);
  const exe = buildHunkExe([{ type: 'CODE', payload }]);

  it('names the large-binary under-declaration mode', () => {
    const audit = auditCnf(exe, 'OFFSET $0\nCODE $00000000 - $00000020\nEND\n', 'exe', 'bad.cnf');
    expect(audit.coverage).toBeLessThan(0.01);
    expect(audit.assessment).toMatch(/large-binary|under-declared/);
  });

  it('full declaration audits as healthy', () => {
    const audit = auditCnf(exe, 'OFFSET $0\nCODE $00000000 - $00010000\nEND\n', 'exe', 'good.cnf');
    expect(audit.coverage).toBe(1);
    expect(audit.assessment).toMatch(/healthy/);
  });
});

describe('carveIslands — pointer tables from reloc runs', () => {
  it('carves runs of consecutive relocated longwords but not isolated relocs', () => {
    const payload = new Uint8Array(512).fill(0x4e);
    const exe = buildHunkExe([
      {
        type: 'CODE',
        payload,
        relocs: [
          // A jump table: 6 consecutive relocated longwords at 0x100.
          { targetHunk: 0, offsets: [0x100, 0x104, 0x108, 0x10c, 0x110, 0x114] },
          // Isolated operand relocs — inside instructions, NOT data.
          { targetHunk: 0, offsets: [0x20, 0x60] },
        ],
      },
    ]);
    const [hunk] = parseHunkFile(exe);
    const islands = carveIslands(exe.subarray(hunk.fileOffset!, hunk.fileOffset! + hunk.size), hunk);
    const table = islands.find((i) => i.kind === 'pointer-table');
    expect(table).toEqual({ start: 0x100, end: 0x118, kind: 'pointer-table' });
    expect(islands.every((i) => i.start > 0x60 || i.end <= 0x20)).toBe(true);
  });
});

describe('dcxRatio', () => {
  it('measures the DC.x directive fraction of an .asm', () => {
    const asm = ['\tMOVE.W\tD0,D1', '\tDC.W\t$1234', '\tDC.B\t$56', '\tRTS', 'LAB_1:\tDC.L\t$DEADBEEF'].join('\n');
    const r = dcxRatio(asm);
    expect(r.dcLines).toBe(3);
    expect(r.totalLines).toBe(5);
    expect(r.ratio).toBe(0.6);
  });
});

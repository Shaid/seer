import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHunkExe } from '@seer-project/amiga';
import { triageDirectory, triageFile, tosecTitle } from '../triage.js';
import { buildZip } from './zip.test.js';
import { randomBytes } from './helpers.js';

describe('tosecTitle', () => {
  it('collapses release variants of one game onto its title', () => {
    const variants = [
      '1000cc Turbo (1990)(Energize)[cr CSL][a]',
      '1000cc Turbo (1990)(Energize)[cr CSL][h KTS]',
      '1000cc Turbo (1990)(Energize)[t +9 SCX]',
    ];
    expect(variants.map(tosecTitle)).toEqual(['1000cc Turbo', '1000cc Turbo', '1000cc Turbo']);
  });

  it('keeps distinct games distinct, including numbered sequels', () => {
    expect(tosecTitle('Shadow of the Beast II (1990)(Psygnosis)')).toBe('Shadow of the Beast II');
    expect(tosecTitle('Dune (1992)(Virgin)(FR)')).toBe('Dune');
  });

  it('returns null for names that do not follow the convention', () => {
    expect(tosecTitle('README')).toBeNull();
    expect(tosecTitle('somegame_v1.2_AGA')).toBeNull();
  });
});

describe('triageFile', () => {
  it('reports dominant class, hunk and ADF flags', () => {
    const zeros = triageFile(new Uint8Array(4096));
    expect(zeros.dominantClass).toBe('zero-fill');
    expect(zeros.isHunk).toBe(false);
    expect(zeros.isAdf).toBe(false);

    const exe = triageFile(buildHunkExe([{ type: 'CODE', payload: new Uint8Array(64).fill(0x4e) }]));
    expect(exe.isHunk).toBe(true);

    const adf = triageFile(new Uint8Array(901120));
    expect(adf.isAdf).toBe(true);
  });
});

describe('triageDirectory', () => {
  it('groups by top-level subdirectory and aggregates per extension', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-triage-'));
    try {
      mkdirSync(join(dir, 'gameA', 'data'), { recursive: true });
      mkdirSync(join(dir, 'gameB'), { recursive: true });
      writeFileSync(join(dir, 'gameA', 'data', 'one.dat'), new Uint8Array(2048));
      writeFileSync(join(dir, 'gameA', 'data', 'two.dat'), randomBytes(2048, 3));
      writeFileSync(join(dir, 'gameA', 'skipme.info'), new Uint8Array(64));
      writeFileSync(join(dir, 'gameB', 'noise.bin'), randomBytes(4096, 5));
      writeFileSync(join(dir, 'rootfile.txt'), new Uint8Array(128));

      const report = triageDirectory(dir);
      // Directories group by their own name; a loose root-level file
      // groups by its stem, so a flat collection of per-game archives
      // (TOSEC's shape) yields one group per game rather than one bucket.
      expect(report.groups.map((g) => g.group)).toEqual(['gameA', 'gameB', 'rootfile']);

      const a = report.groups.find((g) => g.group === 'gameA')!;
      expect(a.files).toBe(2); // .info skipped
      const dat = a.extensions.find((e) => e.ext === '.dat')!;
      expect(dat.count).toBe(2);
      expect(dat.classes).toContain('zero-fill');

      const b = report.groups.find((g) => g.group === 'gameB')!;
      expect(b.files).toBe(1);
      expect(b.containerHits).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('descends into zips, deduping members by stored CRC', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-triage-'));
    try {
      mkdirSync(join(dir, 'game'), { recursive: true });
      const disk = randomBytes(2048, 9);
      // Two zips carrying the same member payload — TOSEC's duplicate-dump shape.
      writeFileSync(join(dir, 'game', 'dump1.zip'), buildZip([{ name: 'Disk1.adf', data: disk }]));
      writeFileSync(join(dir, 'game', 'dump2.zip'), buildZip([{ name: 'Disk1_alt.adf', data: disk }]));

      const report = triageDirectory(dir);
      const [g] = report.groups;
      expect(g.files).toBe(1); // one logical payload triaged...
      expect(g.duplicatesSkipped).toBe(1); // ...the second dump skipped by CRC
      expect(g.extensions[0].ext).toBe('.adf');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a duplicate archive having read only its tail, not its payloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-triage-'));
    try {
      mkdirSync(join(dir, 'game'), { recursive: true });
      // Incompressible payloads, so the archives are genuinely large.
      const disk = randomBytes(400_000, 21);
      const zipA = buildZip([{ name: 'A.adf', data: disk }]);
      const zipB = buildZip([{ name: 'B.adf', data: disk }]);
      writeFileSync(join(dir, 'game', 'a.zip'), zipA);
      writeFileSync(join(dir, 'game', 'b.zip'), zipB);

      // Measure the marginal cost of the duplicate archive: triage the
      // first alone, then both, and compare bytes read.
      const dirA = mkdtempSync(join(tmpdir(), 'probe-triage-a-'));
      mkdirSync(join(dirA, 'game'), { recursive: true });
      writeFileSync(join(dirA, 'game', 'a.zip'), zipA);
      const alone = triageDirectory(dirA);
      rmSync(dirA, { recursive: true, force: true });

      const both = triageDirectory(dir);
      expect(both.duplicatesSkipped).toBe(1);
      // The duplicate must cost its EOCD + central directory only — a
      // few hundred bytes — not another 400 KB payload transfer.
      const marginal = both.bytesRead - alone.bytesRead;
      expect(marginal).toBeLessThan(1024);
      expect(both.bytesRead).toBeLessThan(both.totalBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('samples files above the full-read limit instead of reading them whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-triage-'));
    try {
      mkdirSync(join(dir, 'game'), { recursive: true });
      const big = randomBytes(6 * 1024 * 1024, 33);
      writeFileSync(join(dir, 'game', 'big.bin'), big);

      const report = triageDirectory(dir, { fullReadBytes: 1024 * 1024 });
      expect(report.sampledFiles).toBe(1);
      expect(report.groups[0].files).toBe(1);
      // Size is still reported in full even though only samples were read.
      expect(report.groups[0].bytes).toBe(big.length);
      expect(report.bytesRead).toBeLessThan(big.length);
      expect(report.totalBytes).toBe(big.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces container hits with corpus-relative paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-triage-'));
    try {
      mkdirSync(join(dir, 'game'), { recursive: true });
      // A HUNK-wrapped 8SVX — the layered case the scanner exists for.
      const body = new Uint8Array(64).map((_, i) => (i * 3) & 0x7f);
      const vhdr = [0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0x20, 0x00, 1, 0, 0, 1, 0, 0];
      const svx = Uint8Array.from([
        0x46, 0x4f, 0x52, 0x4d, 0, 0, 0, 4 + 8 + 20 + 8 + 64,
        0x38, 0x53, 0x56, 0x58,
        0x56, 0x48, 0x44, 0x52, 0, 0, 0, 20, ...vhdr,
        0x42, 0x4f, 0x44, 0x59, 0, 0, 0, 64, ...body,
      ]);
      writeFileSync(join(dir, 'game', 'sfx.a'), buildHunkExe([{ type: 'CODE', payload: svx }]));

      const [g] = triageDirectory(dir).groups;
      const kinds = g.containers.map((c) => c.kind);
      expect(kinds).toContain('hunk-wrapped');
      expect(kinds).toContain('iff-8svx');
      expect(g.containers.every((c) => c.file === 'game/sfx.a')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

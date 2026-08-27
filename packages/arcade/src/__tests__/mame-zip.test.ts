import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { readMameZip } from '../mame-zip.js';

// Hand-build a minimal 2-entry ZIP (one stored, one deflated) rather than
// depending on a real romset fixture -- exercises both compression methods
// MAME/TorrentZip ever emit without vendoring copyrighted ROM data.
function buildZip(entries: { name: string; data: Buffer; deflate: boolean }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (unused by reader)
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt32LE(0, 36);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirStart = offset;
  const centralDir = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

describe('readMameZip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mame-zip-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads stored and deflated entries back byte-exact', () => {
    const stored = Buffer.from('stored payload, unchanged bytes');
    const deflated = Buffer.from('deflated payload '.repeat(50)); // compressible

    const zipPath = join(dir, 'test.zip');
    writeFileSync(
      zipPath,
      buildZip([
        { name: 'a.bin', data: stored, deflate: false },
        { name: 'b.bin', data: deflated, deflate: true },
      ]),
    );

    const result = readMameZip(zipPath);
    expect(result.size).toBe(2);
    expect(Buffer.from(result.get('a.bin')!)).toEqual(stored);
    expect(Buffer.from(result.get('b.bin')!)).toEqual(deflated);
  });

  it('throws on a non-ZIP file', () => {
    const badPath = join(dir, 'not-a-zip.bin');
    writeFileSync(badPath, Buffer.from('this is not a zip file at all'));
    expect(() => readMameZip(badPath)).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { crc32, isZipFile, listZip, readZipEntry } from '../zip.js';

/** Minimal in-test ZIP builder (stored or deflate), central directory included. */
export function buildZip(members: { name: string; data: Uint8Array; store?: boolean }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  for (const m of members) {
    const method = m.store ? 0 : 8;
    const payload = m.store ? m.data : new Uint8Array(deflateRawSync(m.data));
    const crc = crc32(m.data);
    const nameBytes = [...m.name].map((c) => c.charCodeAt(0));
    const local = Uint8Array.from([
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(payload.length), ...u32(m.data.length), ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ]);
    central.push(
      Uint8Array.from([
        0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(payload.length), ...u32(m.data.length), ...u16(nameBytes.length), ...u16(0),
        ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes,
      ]),
    );
    parts.push(local, payload);
    offset += local.length + payload.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = Uint8Array.from([
    0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(members.length), ...u16(members.length),
    ...u32(cdSize), ...u32(offset), ...u16(0),
  ]);
  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of [...parts, ...central, eocd]) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const fileA = new Uint8Array(600).map((_, i) => (i * 11) & 0xff);
const fileB = new Uint8Array(64).fill(0x42);

describe('zip', () => {
  const zip = buildZip([
    { name: 'GameDisk.adf', data: fileA },
    { name: 'ReadMe.txt', data: fileB, store: true },
  ]);

  it('detects zip files', () => {
    expect(isZipFile(zip)).toBe(true);
    expect(isZipFile(fileA)).toBe(false);
  });

  it('lists central-directory entries with sizes and CRCs', () => {
    const entries = listZip(zip)!;
    expect(entries.map((e) => [e.name, e.size])).toEqual([
      ['GameDisk.adf', 600],
      ['ReadMe.txt', 64],
    ]);
    expect(entries[0].crc32).toBe(crc32(fileA));
  });

  it('round-trips both stored and deflated members', () => {
    const [a, b] = listZip(zip)!;
    expect(readZipEntry(zip, a)).toEqual(fileA);
    expect(readZipEntry(zip, b)).toEqual(fileB);
  });

  it('returns null for non-zip data', () => {
    expect(listZip(fileA)).toBeNull();
  });
});

describe('crc32', () => {
  it('matches the standard test vector', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe(0xcbf43926);
  });
});

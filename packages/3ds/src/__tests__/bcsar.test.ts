import { describe, expect, it } from 'vitest';
import { parseCbnkWaveIds, parseCwar, parseCwsd, resolveCsarWaveLayout, type Csar } from '../bcsar.js';

function w32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
  b[o + 2] = (v >> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
function w16(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
}
const tag = (b: Uint8Array, o: number, s: string) => s.split('').forEach((c, i) => (b[o + i] = c.charCodeAt(0)));

describe('bcsar embedded files', () => {
  it('parses CWAR wave offsets relative to FILE+8', () => {
    const b = new Uint8Array(0x200);
    tag(b, 0, 'CWAR');
    w16(b, 0x10, 2);
    w16(b, 0x14, 0x6800);
    w32(b, 0x18, 0x40);
    w16(b, 0x20, 0x6801);
    w32(b, 0x24, 0x100);
    tag(b, 0x40, 'INFO');
    w32(b, 0x48, 2);
    w16(b, 0x4c, 0x1f00);
    w32(b, 0x50, 0x18);
    w32(b, 0x54, 0x40);
    w16(b, 0x58, 0x1f00);
    w32(b, 0x5c, 0x58);
    w32(b, 0x60, 0x20);
    const w = parseCwar(b);
    expect(w).toEqual([
      { offset: 0x100 + 8 + 0x18, size: 0x40 },
      { offset: 0x100 + 8 + 0x58, size: 0x20 },
    ]);
  });

  it('parses a CBNK wave-id table', () => {
    const b = new Uint8Array(0x100);
    tag(b, 0, 'CBNK');
    w32(b, 0x18, 0x20);
    tag(b, 0x20, 'INFO');
    w16(b, 0x28, 0x0100);
    w32(b, 0x2c, 0x10);
    const t = 0x28 + 0x10;
    w32(b, t, 2);
    w32(b, t + 4, 0x05000003);
    w32(b, t + 8, 0);
    w32(b, t + 12, 0x05000003);
    w32(b, t + 16, 1);
    expect(parseCbnkWaveIds(b)).toEqual([
      { archiveId: 0x05000003, waveIndex: 0 },
      { archiveId: 0x05000003, waveIndex: 1 },
    ]);
  });

  it('parses a CWSD wave-id table and per-wave-sound indices', () => {
    // INFO at 0x20; payload base 0x28. wave-id table at +0x10, ws table at +0x28.
    const b = new Uint8Array(0x200);
    tag(b, 0, 'CWSD');
    w32(b, 0x18, 0x20);
    tag(b, 0x20, 'INFO');
    w16(b, 0x28, 0x0100);
    w32(b, 0x2c, 0x10);
    w16(b, 0x30, 0x0101);
    w32(b, 0x34, 0x28);
    const ids = 0x28 + 0x10;
    w32(b, ids, 1);
    w32(b, ids + 4, 0x05000002);
    w32(b, ids + 8, 7);
    const ws = 0x28 + 0x28;
    w32(b, ws, 1);
    w16(b, ws + 4, 0x4900);
    w32(b, ws + 8, 0x10); // record at ws+0x10
    const rec = ws + 0x10;
    w16(b, rec + 0x10, 0x0101);
    w32(b, rec + 0x14, 0x40); // table at rec+0x40
    const tbl = rec + 0x40;
    w32(b, tbl, 1);
    w16(b, tbl + 4, 0x4902);
    w32(b, tbl + 8, 0xc);
    w32(b, tbl + 0xc, 0); // wave-id index 0
    const c = parseCwsd(b);
    expect(c.waveIds).toEqual([{ archiveId: 0x05000002, waveIndex: 7 }]);
    expect(c.waveSounds).toEqual([{ waveIndex: 0 }]);
  });

  it('resolves archive and wave names through banks, sound groups and wave sounds', () => {
    const csar = {
      sounds: [
        { index: 0, name: 'SE_A', fileId: 9, kind: 'wave', waveSoundIndex: 0 },
        { index: 1, name: 'SE_B', fileId: 9, kind: 'wave', waveSoundIndex: 1 },
      ],
      waveArchives: [
        { index: 0, name: '', fileId: 1, waveCount: 0 },
        { index: 1, name: 'WARC_X', fileId: 2, waveCount: 3 },
      ],
      soundGroups: [{ index: 0, name: 'WSDSET_A', firstSound: 0, lastSound: 1 }],
      banks: [{ index: 0, name: 'BANK_B', fileId: 5 }],
    } as unknown as Csar;
    const cwsds = new Map([
      [
        9,
        {
          waveIds: [
            { archiveId: 0x05000000, waveIndex: 4 },
            { archiveId: 0x05000001, waveIndex: 2 },
          ],
          waveSounds: [{ waveIndex: 0 }, { waveIndex: 1 }],
        },
      ],
    ]);
    const cbnks = new Map([[5, [{ archiveId: 0x05000000, waveIndex: 0 }]]]);
    const r = resolveCsarWaveLayout(csar, cwsds, cbnks);
    expect(r.unresolved).toBe(0);
    expect(r.archives[0]!.name).toBe('B');
    expect(r.archives[0]!.nameSource).toBe('bank');
    expect(r.archives[0]!.waveNames.get(4)).toEqual(['SE_A']);
    expect(r.archives[1]!.name).toBe('WARC_X');
    expect(r.archives[1]!.waveNames.get(2)).toEqual(['SE_B']);
    // null control: a broken wave-id table resolves nothing
    const bad = resolveCsarWaveLayout(csar, new Map(), cbnks);
    expect(bad.unresolved).toBe(2);
  });
});

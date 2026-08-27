import { describe, it, expect } from 'vitest';
import {
  decodeCps1PaletteWord,
  decodeCps1PaletteWords,
  decodeCps1PaletteWordsForced,
  scanCpsPaletteCopySites,
  scanCps2PaletteBankSites,
  type CpsPaletteCopySite,
} from '../capcom/palette.js';

describe('decodeCps1PaletteWord', () => {
  it('decodes black (0xf000) to (0,0,0) at full brightness', () => {
    expect(decodeCps1PaletteWord(0xf000)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('decodes white (0xffff) to (255,255,255) at full brightness', () => {
    expect(decodeCps1PaletteWord(0xffff)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('decodes pure red at full brightness (0xff00) to (255,0,0)', () => {
    expect(decodeCps1PaletteWord(0xff00)).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('decodes pure green at full brightness (0xf0f0) to (0,255,0)', () => {
    expect(decodeCps1PaletteWord(0xf0f0)).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('decodes pure blue at full brightness (0xf00f) to (0,0,255)', () => {
    expect(decodeCps1PaletteWord(0xf00f)).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('reduces brightness to roughly 1/3 when the brightness nibble is 0', () => {
    // bright = 0x0f + (0 << 1) = 0x0f; ratio = 0x0f / 0x2d = 1/3.
    const { r } = decodeCps1PaletteWord(0x0f00);
    expect(r).toBe(Math.round((0xf * 0x11 * 0x0f) / 0x2d));
    expect(r).toBeLessThan(90); // well under 255/3 + rounding slack
  });

  it('matches the real knights.zip boot-palette word for entry 0 (0xf111 -> (17,17,17))', () => {
    // See docs/knights/cps1/data-structure.md sec 3.3 -- confirmed via a
    // traced 68000 boot code path (maincpu.bin file offset 0x1554).
    expect(decodeCps1PaletteWord(0xf111)).toEqual({ r: 17, g: 17, b: 17 });
  });
});

describe('decodeCps1PaletteWords', () => {
  it('decodes consecutive big-endian words from a byte buffer', () => {
    // Two words: 0xf000 (black), 0xffff (white).
    const data = new Uint8Array([0xf0, 0x00, 0xff, 0xff]);
    const colors = decodeCps1PaletteWords(data, 0, 2);
    expect(colors).toEqual([
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
    ]);
  });

  it('honors a nonzero byteOffset', () => {
    const data = new Uint8Array([0xaa, 0xbb, 0xf0, 0x00]);
    const colors = decodeCps1PaletteWords(data, 2, 1);
    expect(colors).toEqual([{ r: 0, g: 0, b: 0 }]);
  });
});

describe('decodeCps1PaletteWordsForced', () => {
  it('forces the brightness nibble to 0xf regardless of the stored value', () => {
    // Stored word 0x0f00 (brightness nibble 0, would normally be ~1/3
    // brightness); the ddsom boot copy loop's `ori.l #$f000f000,Dn` idiom
    // (see docs/ddsom/cps2/data-structure.md sec 3.5) forces this to 0xff00
    // before it reaches CPS-B palette RAM -- full-brightness pure red.
    const data = new Uint8Array([0x0f, 0x00]);
    expect(decodeCps1PaletteWordsForced(data, 0, 1)).toEqual([{ r: 255, g: 0, b: 0 }]);
  });

  it('matches the plain decoder when the stored brightness nibble is already 0xf', () => {
    const data = new Uint8Array([0xf1, 0x11]);
    expect(decodeCps1PaletteWordsForced(data, 0, 1)).toEqual(decodeCps1PaletteWords(data, 0, 1));
  });
});

describe('scanCpsPaletteCopySites', () => {
  /** Build a big-endian 68000 word stream. */
  function words(...vals: number[]): Uint8Array {
    const bytes: number[] = [];
    for (const v of vals) {
      bytes.push((v >> 8) & 0xff, v & 0xff);
    }
    return new Uint8Array(bytes);
  }

  /** Concatenate byte arrays into one growable buffer. */
  function concat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /**
   * Emit a minimal SF2-style palette setup + brightness-forced copy loop:
   *
   *   lea.l  DEST, a1            (0x43f9 imm32)
   *   movea.l #SRC, a0           (0x207c imm32)
   *   move.w #N-1, d7            (0x3e3c imm16)      -- dbra counter
   *   .loop: 4x { move.l (a0)+,d0 / addi.l #$f000f000,d0 / move.l d0,(a1)+ }
   *   dbra d7, .loop             (0x51cf rel16)
   */
  function paletteRoutine(src: number, dest: number, iterations: number): Uint8Array {
    const parts: Uint8Array[] = [
      words(0x43f9, (dest >>> 16) & 0xffff, dest & 0xffff),
      words(0x207c, (src >>> 16) & 0xffff, src & 0xffff),
    ];
    const loopStart = parts.reduce((n, p) => n + p.length, 0);
    parts.push(words(0x3e3c, iterations - 1));
    const body = words(0x2018, 0x0680, 0xf000, 0xf000, 0x22c0);
    for (let i = 0; i < 4; i++) parts.push(body);
    const dbraOff = parts.reduce((n, p) => n + p.length, 0);
    parts.push(words(0x51cf, 0x0000));
    const img = concat(...parts);
    // rel16 = loop body start - (dbra + 2)
    const rel = loopStart - (dbraOff + 2);
    img[dbraOff + 2] = (rel >> 8) & 0xff;
    img[dbraOff + 3] = rel & 0xff;
    return img;
  }

  it('finds a single SF2-style copy site with src/dest and bank count', () => {
    const img = paletteRoutine(0x00c0000, 0x900400, 32);
    const sites = scanCpsPaletteCopySites(img);
    expect(sites).toHaveLength(1);
    const s = sites[0];
    expect(s.src).toBe(0x0c0000);
    expect(s.dest).toBe(0x900400);
    expect(s.forced).toBe(true);
    // 4 longwords/iter × 32 iterations × 4 bytes = 512 bytes = 16 banks
    expect(s.copyBytes).toBe(512);
    expect(s.banks).toBe(16);
  });

  it('collects distinct sources that share one copy loop (SF2 stage pattern)', () => {
    // Three setups bra-ing into the same shared loop body: two distinct src.
    const a = paletteRoutine(0x0c0000, 0x900400, 32);
    const b = paletteRoutine(0x0c5000, 0x900800, 32);
    const img = new Uint8Array(a.length + b.length + 16);
    img.set(a, 0);
    // A branch between setups so the backward src scan doesn't cross them.
    img.set(b, a.length + 16);
    const sites = scanCpsPaletteCopySites(img);
    const srcs = sites.map((s: CpsPaletteCopySite) => s.src).sort();
    expect(srcs).toContain(0x0c0000);
    expect(srcs).toContain(0x0c5000);
  });

  it('ignores addi #$f000f000 not inside the copy idiom', () => {
    const img = words(0x0680, 0xf000, 0xf000, 0x4e75);
    expect(scanCpsPaletteCopySites(img)).toHaveLength(0);
  });

  it('returns empty for a buffer with no brightness-forcing copy', () => {
    const img = words(0x4e75, 0x207c, 0x00, 0xc0, 0x22d8);
    expect(scanCpsPaletteCopySites(img)).toHaveLength(0);
  });
});

describe('scanCps2PaletteBankSites', () => {
  /** Build big-endian 68000 words into a byte buffer (growable). */
  function words(...vals: number[]): Uint8Array {
    const bytes: number[] = [];
    for (const v of vals) bytes.push((v >> 8) & 0xff, v & 0xff);
    return new Uint8Array(bytes);
  }

  /**
   * Emit a ddsom-style CPS2 palette-bank copy: the fixed 52-byte block
   *   lea.l  DEST, a1            (0x43f9 imm32)
   *   lea.l  SRC, a2             (0x45f9 imm32)
   *   movem.l (a2)+, d1-d6/a3-a4 (0x4cda 0x187e)
   *   6 × ori.l #$f000f000, dN   (0x0081..0x0086, imm32 each)
   *   2 × adda.l #$f000f000, aX  (0xd7fc/d9fc, imm32 each)
   *   movem.l d1-d6/a3-a4, (a1)  (0x48d1 0x187e)
   */
  function bankRoutine(src: number, dest: number): Uint8Array {
    const part = (content: Uint8Array) => content;
    const pieces = [
      words(0x43f9, (dest >>> 16) & 0xffff, dest & 0xffff),
      words(0x45f9, (src >>> 16) & 0xffff, src & 0xffff),
      words(0x4cda, 0x187e),
      words(0x0081, 0xf000, 0xf000),
      words(0x0082, 0xf000, 0xf000),
      words(0x0083, 0xf000, 0xf000),
      words(0x0084, 0xf000, 0xf000),
      words(0x0085, 0xf000, 0xf000),
      words(0x0086, 0xf000, 0xf000),
      words(0xd7fc, 0xf000, 0xf000),
      words(0xd9fc, 0xf000, 0xf000),
      words(0x48d1, 0x187e),
    ];
    const total = pieces.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of pieces) {
      out.set(part(p), o);
      o += p.length;
    }
    return out;
  }

  it('finds a single ddsom-style bank copy with src/dest', () => {
    const img = bankRoutine(0x2537c0, 0x91c3c0);
    const sites = scanCps2PaletteBankSites(img);
    expect(sites).toHaveLength(1);
    expect(sites[0].src).toBe(0x2537c0);
    expect(sites[0].dest).toBe(0x91c3c0);
    expect(sites[0].banks).toBe(1);
    expect(sites[0].copyBytes).toBe(32); // one 16-color bank
    expect(sites[0].forced).toBe(true);
  });

  it('finds multiple bank copies in a sequence', () => {
    const a = bankRoutine(0x2537c0, 0x91c3c0);
    const b = bankRoutine(0x28f4c0, 0x91c180);
    const img = new Uint8Array(a.length + b.length);
    img.set(a, 0);
    img.set(b, a.length);
    const sites = scanCps2PaletteBankSites(img);
    expect(sites).toHaveLength(2);
    const srcs = sites.map((s) => s.src).sort();
    expect(srcs).toEqual([0x2537c0, 0x28f4c0]);
  });

  it('returns empty when the ori/adda block is not in the movem store pattern', () => {
    // One ori.l only, no adda, no store.
    const img = words(0x0081, 0xf000, 0xf000, 0x4e75);
    expect(scanCps2PaletteBankSites(img)).toHaveLength(0);
  });

  it('returns empty for a buffer that is not code', () => {
    const img = words(0x0000, 0x0000, 0x0000, 0x0000);
    expect(scanCps2PaletteBankSites(img)).toHaveLength(0);
  });
});

/**
 * Synthetic HUNK executable builder — the inverse of `parseHunkFile`.
 *
 * Exists so tests (here and in consumers like `@seer-project/probe`) can
 * construct loadseg()-able fixtures with known CODE/DATA/BSS layout,
 * relocations and symbols instead of committing binary blobs. Not a
 * linker: it writes exactly what it's told, one HUNK_END per hunk.
 */

import {
  HUNK_HEADER,
  HUNK_CODE,
  HUNK_DATA,
  HUNK_BSS,
  HUNK_RELOC32,
  HUNK_SYMBOL,
  HUNK_END,
  type HunkType,
  type HunkReloc32,
  type HunkSymbol,
} from './hunk.js';

export interface HunkSpec {
  type: HunkType;
  /** Payload bytes for CODE/DATA (padded to a longword boundary in the file). Ignored for BSS. */
  payload?: Uint8Array;
  /** Memory size in longwords. Defaults to the padded payload length for CODE/DATA; required for BSS. */
  memLongwords?: number;
  /** Set the MEMF_CHIP flag bit on both the header size-table entry and the in-stream tag (exercises `& 0x3FFFFFFF` masking). */
  chipMem?: boolean;
  relocs?: HunkReloc32[];
  symbols?: HunkSymbol[];
}

const MEMF_CHIP_FLAG = 0x40000000;

/** A big-endian byte stream assembled from longwords and raw byte runs. */
class Stream {
  private parts: Uint8Array[] = [];
  private length = 0;

  long(v: number): void {
    const b = new Uint8Array(4);
    b[0] = (v >>> 24) & 0xff;
    b[1] = (v >>> 16) & 0xff;
    b[2] = (v >>> 8) & 0xff;
    b[3] = v & 0xff;
    this.bytes(b);
  }

  bytes(b: Uint8Array): void {
    this.parts.push(b);
    this.length += b.length;
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

export function buildHunkExe(specs: HunkSpec[]): Uint8Array {
  const s = new Stream();
  const paddedLongwords = (spec: HunkSpec) =>
    spec.type === 'BSS' ? 0 : Math.ceil((spec.payload?.length ?? 0) / 4);

  s.long(HUNK_HEADER);
  s.long(0); // no resident library names
  s.long(specs.length); // table_size
  s.long(0); // first hunk
  s.long(specs.length - 1); // last hunk
  for (const spec of specs) {
    const mem = spec.memLongwords ?? paddedLongwords(spec);
    s.long(mem | (spec.chipMem ? MEMF_CHIP_FLAG : 0));
  }

  for (const spec of specs) {
    const flag = spec.chipMem ? MEMF_CHIP_FLAG : 0;
    if (spec.type === 'BSS') {
      s.long(HUNK_BSS | flag);
      s.long(spec.memLongwords ?? 0);
    } else {
      s.long((spec.type === 'CODE' ? HUNK_CODE : HUNK_DATA) | flag);
      s.long(paddedLongwords(spec));
      const padded = new Uint8Array(paddedLongwords(spec) * 4);
      if (spec.payload) padded.set(spec.payload);
      s.bytes(padded);
    }

    if (spec.relocs?.length) {
      s.long(HUNK_RELOC32);
      for (const r of spec.relocs) {
        s.long(r.offsets.length);
        s.long(r.targetHunk);
        for (const o of r.offsets) s.long(o);
      }
      s.long(0);
    }
    if (spec.symbols?.length) {
      s.long(HUNK_SYMBOL);
      for (const sym of spec.symbols) {
        const nameLongwords = Math.ceil(sym.name.length / 4) || 1;
        s.long(nameLongwords);
        const nameBytes = new Uint8Array(nameLongwords * 4);
        for (let i = 0; i < sym.name.length; i++) nameBytes[i] = sym.name.charCodeAt(i);
        s.bytes(nameBytes);
        s.long(sym.value);
      }
      s.long(0);
    }
    s.long(HUNK_END);
  }

  return s.toUint8Array();
}

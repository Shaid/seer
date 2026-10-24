/**
 * Microsoft EXEPACK decompressor — unpacks a DOS MZ executable's real, flat
 * load image from its EXEPACK-compressed on-disk form.
 *
 * EXEPACK is Microsoft's own compressor, shipped with `LINK.EXE`/
 * `EXEPACK.EXE` — a pure run-length/verbatim-block scheme (not LZ77-style
 * back-references) decompressed in place, back-to-front. Every byte offset
 * in the *packed* file is meaningless as a code/data address: the codec
 * elides runs of repeated bytes, so an address quoted as
 * `fileOffset - headerSize` is only accidentally right wherever no
 * compression happened to occur before it. Disassembling or byte-searching
 * the packed file will not locate real code/data — unpack first.
 *
 * Detection: the EXEPACK header sits at `e_cs*16` in the MZ-header-stripped
 * load image (the program's declared entry *segment*), is 16 bytes long,
 * and carries the ASCII signature `"RB"` in its last word. `e_ip` equals
 * the header size (16), and the unpacker code follows immediately.
 *
 * Self-verification performed (all must hold; `unpackExepack` throws
 * `ExepackError` otherwise):
 *   - the `"RB"` signature is present;
 *   - `e_ip` == the header size (16);
 *   - the block loop terminates on a command byte with bit 0 set, and at
 *     that point the source and destination cursors are *equal* — EXEPACK
 *     expands in place, so an unequal pair means the stream was misparsed;
 *   - the relocation table starting at `exepackHeader + 0x112` ends exactly
 *     at `exepackHeader + exepackSize`;
 *   - every relocation entry points at a word whose value is below
 *     `destLenParagraphs` (i.e. a real segment inside the image).
 *
 * Output is the raw load image (`destLenParagraphs` paragraphs), i.e. the
 * bytes DOS would have at `loadSegment:0000`. With that image, an address
 * written in disassembly as `SEG:OFF` is simply image offset
 * `SEG * 16 + OFF` (`loadBase = 0`).
 *
 * See this package's README for how EXEPACK relates to (and differs from)
 * LZEXE, which stays in `@seer-project/pipeline`.
 */

import { asciiAt, r16 } from '@seer-project/core';

export class ExepackError extends Error {}

/** Offset of the relocation table within the EXEPACK stub segment — a property of the stub build (it loads it with `mov si, 0x112`), not of the file. */
const RELOC_TABLE_OFF = 0x112;

export interface ExepackInfo {
  /** Byte offset of the EXEPACK header within `body` (`e_cs * 16`) — everything before it is the compressed `packed` block. */
  packedBody: number;
  /** Total decompressed image size in bytes (`destLenParagraphs * 16`). */
  imageSize: number;
  /** Number of run-length/verbatim blocks the decompressor processed. */
  blocks: number;
  /** Count of trailing `0xFF` filler bytes the stub skips before the first block command. */
  ffPad: number;
  /** Byte length of the incompressible "verbatim head" copied directly from `packed[0:headVerbatim]`. */
  headVerbatim: number;
  /** Real program entry point, as `(cs, ip)` — informational, not validated. */
  entry: readonly [cs: number, ip: number];
  /** Real program stack pointer, as `(ss, sp)` — informational, not validated. */
  stack: readonly [ss: number, sp: number];
  /** `mem_start` field from the EXEPACK header — informational, not validated. */
  memStart: number;
  /** Decompressed image size in 16-byte paragraphs (`imageSize / 16`). */
  destLenParagraphs: number;
  /** Byte length of the EXEPACK header + relocation table (`relocTableEnd - packedBody`). */
  exepackSize: number;
  /** Flat image-offset targets of every relocation entry. */
  relocs: number[];
}

/** Unpack an EXEPACK-compressed MZ executable's bytes into its real load image. */
export function unpackExepack(data: Uint8Array): { image: Uint8Array; info: ExepackInfo } {
  const magic = asciiAt(data, 0, 2);
  if (magic !== 'MZ' && magic !== 'ZM') {
    throw new ExepackError('not an MZ executable');
  }
  const eCblp = r16(data, 2, 'le');
  const eCp = r16(data, 4, 'le');
  const eCparhdr = r16(data, 8, 'le');
  const eIp = r16(data, 20, 'le');
  const eCs = r16(data, 22, 'le');

  const hdrLen = eCparhdr * 16;
  // DOS loads the image size the header declares, zero-filling any tail the
  // file itself is short of. EXEPACK relies on this for its trailing
  // all-zero relocation group counts, so reproduce it.
  const declared = (eCp - 1) * 512 + (eCblp !== 0 ? eCblp : 512);
  const bodyLen = Math.max(0, declared - hdrLen);
  const body = new Uint8Array(bodyLen);
  body.set(data.subarray(hdrLen, Math.min(data.length, hdrLen + bodyLen)));

  const epk = eCs * 16;
  const realIp = r16(body, epk, 'le');
  const realCs = r16(body, epk + 2, 'le');
  const memStart = r16(body, epk + 4, 'le');
  const exepackSize = r16(body, epk + 6, 'le');
  const realSp = r16(body, epk + 8, 'le');
  const realSs = r16(body, epk + 10, 'le');
  const destLen = r16(body, epk + 12, 'le');
  const sig = r16(body, epk + 14, 'le');

  if (String.fromCharCode(sig & 0xff, (sig >> 8) & 0xff) !== 'RB') {
    throw new ExepackError(`no EXEPACK 'RB' signature at e_cs:0x0e (got 0x${sig.toString(16)})`);
  }
  if (eIp !== 16) {
    throw new ExepackError(`e_ip=0x${eIp.toString(16)}, expected 0x10 (16-byte EXEPACK header)`);
  }

  const packed = body.subarray(0, epk);
  // The stub scans back over at most 16 bytes of 0xFF filler.
  let si = packed.length - 1;
  let pad = 0;
  while (si >= 0 && packed[si] === 0xff && pad < 16) {
    si -= 1;
    pad += 1;
  }

  const out = new Uint8Array(destLen * 16);
  let di = out.length - 1;
  let blocks = 0;
  for (;;) {
    const cmd = packed[si];
    si -= 1;
    const count = packed[si - 1] | (packed[si] << 8);
    si -= 2;
    const op = cmd & 0xfe;
    if (op === 0xb0) {
      // run of one repeated byte
      const fill = packed[si];
      si -= 1;
      for (let i = 0; i < count; i++) {
        out[di] = fill;
        di -= 1;
      }
    } else if (op === 0xb2) {
      // verbatim literal run
      for (let i = 0; i < count; i++) {
        out[di] = packed[si];
        di -= 1;
        si -= 1;
      }
    } else {
      throw new ExepackError(
        `bad block command 0x${cmd.toString(16)} at packed offset 0x${(si + 3).toString(16)}`,
      );
    }
    blocks += 1;
    if (cmd & 1) break; // bit 0 = last block
  }
  if (si !== di) {
    throw new ExepackError(`in-place invariant violated: src cursor ${si} != dst cursor ${di}`);
  }
  // Whatever is left is the incompressible head, already in its final place.
  out.set(packed.subarray(0, si + 1), 0);

  let rp = epk + RELOC_TABLE_OFF;
  const relocs: number[] = [];
  for (let group = 0; group < 16; group++) {
    const n = r16(body, rp, 'le');
    rp += 2;
    for (let i = 0; i < n; i++) {
      const off = r16(body, rp, 'le');
      rp += 2;
      relocs.push(group * 0x1000 * 16 + off);
    }
  }
  if (rp !== epk + exepackSize) {
    throw new ExepackError(
      `relocation table ends at 0x${rp.toString(16)}, exepack_size says 0x${(epk + exepackSize).toString(16)}`,
    );
  }
  const bad = relocs.filter((r) => r16(out, r, 'le') >= destLen);
  if (bad.length > 0) {
    throw new ExepackError(`${bad.length}/${relocs.length} relocations point at words >= dest_len`);
  }

  const info: ExepackInfo = {
    packedBody: epk,
    imageSize: out.length,
    blocks,
    ffPad: pad,
    headVerbatim: di + 1,
    entry: [realCs, realIp],
    stack: [realSs, realSp],
    memStart,
    destLenParagraphs: destLen,
    exepackSize,
    relocs,
  };
  return { image: out, info };
}

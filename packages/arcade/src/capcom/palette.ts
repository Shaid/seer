/**
 * CPS1 (Capcom Play System 1) hardware palette-word decoder.
 *
 * Direct port of `cps_state::cps1_build_palette()`
 * (`src/mame/capcom/cps1_v.cpp`, "Build palette from palette RAM" comment
 * block) -- MAME's own authoritative decode of the CPS-B custom chip's
 * palette-RAM word format: 12-bit RGB plus a 4-bit brightness/fade value.
 *
 *   bits 15-12: brightness ("bright = 0x0f + (nibble << 1)", i.e. nibble
 *               0x0 -> 1/3 brightness, 0xf -> full brightness, matching
 *               MAME's comment "when the brightness component is set to 0
 *               it should reduce brightness to 1/3")
 *   bits 11-8:  red   (4-bit)
 *   bits 7-4:   green (4-bit)
 *   bits 3-0:   blue  (4-bit)
 *
 * Each 4-bit channel is expanded to 8-bit via the standard *0x11
 * nibble-replication, then scaled by bright/0x2d (0x2d = 45 = the maximum
 * possible bright value, when the brightness nibble is 0xf).
 *
 * This function is defined once in cps1_v.cpp and shared by both the CPS1
 * driver (cps1.cpp) and the CPS2 driver (cps2.cpp, which builds on CPS1's
 * video hardware) -- likely applicable to CPS2 games (ddsom/ddtod in this
 * project) too, though that is not verified here; see
 * docs/knights/cps1/data-structure.md for the CPS1-specific verification
 * (a real, traced 68000 boot + VBLANK-interrupt code path, not just format
 * plausibility).
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Decode one raw 16-bit CPS-B palette RAM word into 8-bit-per-channel RGB. */
export function decodeCps1PaletteWord(word: number): Rgb {
  const bright = 0x0f + ((word >> 12) << 1);
  const r = Math.round((((word >> 8) & 0x0f) * 0x11 * bright) / 0x2d);
  const g = Math.round((((word >> 4) & 0x0f) * 0x11 * bright) / 0x2d);
  const b = Math.round(((word & 0x0f) * 0x11 * bright) / 0x2d);
  return { r, g, b };
}

/** Decode `count` consecutive big-endian 16-bit words starting at `byteOffset` into an array of RGB colors. */
export function decodeCps1PaletteWords(data: Uint8Array, byteOffset: number, count: number): Rgb[] {
  const out: Rgb[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = byteOffset + i * 2;
    const word = (data[off] << 8) | data[off + 1];
    out[i] = decodeCps1PaletteWord(word);
  }
  return out;
}

/**
 * Same as `decodeCps1PaletteWords()`, but forces the brightness nibble
 * (bits 15-12) to 0xf before decoding each word -- replicates the real
 * 68000 idiom several confirmed CPS1/CPS2 palette-bank-load code paths use
 * (`ori.l #$f000f000,Dn` / `adda.l #$f000f000,An`, or the CPS1 `ori.l
 * #$f000f000,d0` boot-copy form) to unconditionally max out brightness
 * while copying a color table into CPS-B palette RAM -- see
 * docs/knights/cps1/data-structure.md sec 3.3 and
 * docs/ddsom/cps2/data-structure.md sec 3.5. When the real copy applies
 * this OR, the ROM's own stored top nibble is not the displayed value;
 * use this decoder (not the plain one) for those sites so decoded output
 * matches what the CPS-B chip actually receives.
 */
export function decodeCps1PaletteWordsForced(
  data: Uint8Array,
  byteOffset: number,
  count: number,
): Rgb[] {
  const out: Rgb[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = byteOffset + i * 2;
    const word = (data[off] << 8) | data[off + 1] | 0xf000;
    out[i] = decodeCps1PaletteWord(word);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Copy-site scanner
// ---------------------------------------------------------------------------

/**
 * A confirmed fixed-address palette-table copy site found by scanning a
 * (decrypted) 68000 instruction stream for the `move.l (a0)+,d0` /
 * `addi.l #$f000f000,d0` / `move.l d0,(a1)+` brightness-forcing copy idiom.
 *
 * CPS1/CPS2 games ship their color tables in the program ROM and copy them
 * into CPS-B palette shadow RAM at init. The copy paths that KO the
 * brightness nibble are recognizable: each 16-bit palette word stored in
 * ROM has a 0 or non-max top nibble, and the copy `addi.l #$f000f000,d0`
 * unconditionally forces both 16-bit halves' top nibbles to `f`. Decoding
 * must use the *forced* decoder (above) for these sites.
 */
export interface CpsPaletteCopySite {
  /** Byte offset in the instruction image where the copy loop's source load (`movea.l src,a0`) sits. */
  setupOffset: number;
  /** Source address of the color table in the CPU's ROM image. */
  src: number;
  /** Total bytes copied (longwords-per-iteration × iteration count × 4). */
  copyBytes: number;
  /** Number of 16-color (32-byte) banks the copy spans. */
  banks: number;
  /** Destination palette RAM address the copy fills (when the loop setup loads it literally). */
  dest?: number;
  /** True when the loop ORs $f000f000 (brightness forcing); always true for this idiom. */
  forced: boolean;
}

/**
 * Scan a 68000 instruction stream (CPS1 plaintext, or CPS2-decrypted
 * opcode image) for the brightness-forcing palette copy idiom:
 *
 *   lea.l  DST_abs, a1                 (0x43f9 imm32      — palette RAM)
 *   movea.l #SRC, a0                   (0x207c imm32      — ROM table)
 *   ...branch or fall into loop...
 *   move.w #n, d7                      (0x3e3c imm16      — dbra counter)
 *   .loop:
 *   move.l (a0)+, d0                   (0x2018)
 *   addi.l #$f000f000, d0              (0x0680 imm32)
 *   move.l d0, (a1)+                   (0x22c0)
 *   ... 4-8x unrolled ...
 *   dbra d7, .loop                     (0x51cf imm16)
 *
 * The source/dest register loads sit BEFORE the copy loop (often separated
 * by a branch), so after locking onto the repeated `.loop` idiom we walk
 * backward across a generously wide window for the literals -- the source
 * `movea.l #src,a0` and the destination `lea.l dst,a1`. Every match reports
 * the source table address and byte extent (longwords-per-iteration ×
 * (counter+1) × 4) so callers can run `decodeCps1PaletteWordsForced()`
 * over the source range.
 */
export function scanCpsPaletteCopySites(instructions: Uint8Array): CpsPaletteCopySite[] {
  const sites: CpsPaletteCopySite[] = [];
  const w16 = (o: number) => (instructions[o] << 8) | instructions[o + 1];

  // 1) Find every `addi.l #$f000f000, d0` (0x0680 f000 f000) that sits
  //    between `move.l (a0)+, d0` (0x2018) and `move.l d0, (a1)+` (0x22c0).
  for (let i = 2; i + 8 <= instructions.length; i += 2) {
    if (w16(i) !== 0x0680) continue;
    if (w16(i + 2) !== 0xf000 || w16(i + 4) !== 0xf000) continue;
    if (w16(i - 2) !== 0x2018 || w16(i + 6) !== 0x22c0) continue;

    // 2) Walk backward from the addi anchor to the start of the unrolled
    //    block. The triple opens with move.l (a0)+,d0 at anchor-2; each
    //    earlier triple sits one full 10-byte step before it.
    const tripleLen = 10; // move.l (2) + addi.l (6) + move.l (2)
    let firstTriple = i - 2;
    while (firstTriple - tripleLen >= 2 && w16(firstTriple - tripleLen) === 0x2018) {
      firstTriple -= tripleLen;
    }

    // 3) Iteration count = (counter + 1). The counter load (move.w #imm,d7 =
    //    0x303c | dest<<9) is immediately before the block start, possibly
    //    with a branch or stack op in between; scan backward up to 32 bytes.
    let counter = -1;
    for (let s = firstTriple - 2; s >= firstTriple - 34 && s >= 0; s -= 2) {
      if ((w16(s) & 0xf0ff) === 0x303c && s + 4 <= instructions.length) {
        counter = w16(s + 2) & 0xffff;
        break;
      }
    }
    if (counter < 0) continue;

    // 4) Longwords per iteration: count of unrolled [move.l/addi.l/move.l]
    //    triples starting at the block (each triple is 10 bytes).
    let perIter = 0;
    for (let t = firstTriple; t + 2 <= instructions.length && t < firstTriple + 96;) {
      if (w16(t) === 0x2018) perIter++;
      t += 10;
      if (perIter > 0 && t < firstTriple + 96 && w16(t) !== 0x2018) break;
    }
    if (perIter === 0) continue;

    // 5) Source + dest: SF2-style palette-setup functions set up A0/A1 then
    //    `bra` into a SHARED copy loop, so several distinct (src,dest) pairs
    //    can target the same loop block. Collect every source load in the
    //    backward window and emit one site per distinct source.
    const srcLoads: { src: number; dst: number }[] = [];
    const scanStart = Math.max(0, firstTriple - 512);
    let pendingDst = -1;
    for (let s = scanStart; s < firstTriple; s += 2) {
      const op = w16(s);
      if (s + 6 <= instructions.length && (op & 0xf0ff) === 0x40f9) {
        pendingDst =
          (instructions[s + 2] << 24) |
          (instructions[s + 3] << 16) |
          (instructions[s + 4] << 8) |
          instructions[s + 5];
      } else if (s + 6 <= instructions.length && op === 0x227c) {
        pendingDst =
          (instructions[s + 2] << 24) |
          (instructions[s + 3] << 16) |
          (instructions[s + 4] << 8) |
          instructions[s + 5];
      } else if (s + 6 <= instructions.length && op === 0x207c) {
        const src =
          (instructions[s + 2] << 24) |
          (instructions[s + 3] << 16) |
          (instructions[s + 4] << 8) |
          instructions[s + 5];
        srcLoads.push({ src, dst: pendingDst });
        pendingDst = -1;
      }
    }

    const copyBytes = (counter + 1) * perIter * 4;
    for (const { src, dst } of srcLoads) {
      if (sites.some((s) => s.src === src)) continue;
      sites.push({
        setupOffset: scanStart,
        src,
        copyBytes,
        banks: copyBytes / 32,
        forced: true,
        ...(dst >= 0 ? { dest: dst } : {}),
      });
    }
  }

  return sites;
}

// ---------------------------------------------------------------------------
// CPS2 movem.l / ori.l / adda.l idiom scanner
// ---------------------------------------------------------------------------

/**
 * Scan a (decrypted) 68000 instruction stream for the CPS2 palette-bank
 * copy idiom kolbold's ddsom RE confirmed (see kolbold
 * docs/ddsom/cps2/data-structure.md sec 3.5): each fixed-address site
 * copies ONE 16-color bank into CPS-B palette shadow RAM:
 *
 *   lea.l  DEST, a1            (0x43f9 imm32)
 *   lea.l  SRC, a2             (0x45f9 imm32)
 *   movem.l (a2)+, d1-d6/a3-a4 (0x4cda 0x187e)
 *   ori.l  #$f000f000, d1..d6  (0x0081-0x0086, each imm32)
 *   adda.l #$f000f000, a3/a4   (0xd7fc / 0xd9fc, each imm32)
 *   movem.l d1-d6/a3-a4, (a1)  (0x48d1 0x187e)
 *
 * Source/dest register loads may be `lea.l` (0x41f9/0x43f9/0x45f9...) or
 * `movea.l #imm` (0x227c/0x247c) variants, sitting a few words before the
 * movem/ori block. Each match reports one 16-color (32-byte) bank.
 */
export function scanCps2PaletteBankSites(instructions: Uint8Array): CpsPaletteCopySite[] {
  const sites: CpsPaletteCopySite[] = [];
  const w16 = (o: number) => (instructions[o] << 8) | instructions[o + 1];
  const W = (o: number) =>
    (instructions[o] << 24) |
    (instructions[o + 1] << 16) |
    (instructions[o + 2] << 8) |
    instructions[o + 3];

  // Anchor: the `movem.l d1-d6/a3-a4, (a1)` store (0x48d1 0x187e) that ends
  // every site. Its 6 ori.l + 2 adda.l preface is checkable backward.
  for (let i = 4; i + 4 <= instructions.length; i += 2) {
    if (w16(i) !== 0x48d1 || w16(i + 2) !== 0x187e) continue;

    // Backward from the store: adda.l a4 / adda.l a3, then ori.l d6..d1.
    // Each is 6 bytes (opcode + imm32); the whole block before the store is
    // 52 bytes: movem.l(4) + ori d1-d6(36) + adda a3/a4(12).
    if (i < 56) continue;
    const adda4 = w16(i - 6);
    const adda3 = w16(i - 12);
    if (adda4 !== 0xd9fc || adda3 !== 0xd7fc) continue;
    let at = i - 18;
    let ok = true;
    for (let d = 6; d >= 1; d--) {
      if (w16(at) !== (0x0080 | d) || w16(at + 2) !== 0xf000 || w16(at + 4) !== 0xf000) {
        ok = false;
        break;
      }
      at -= 6;
    }
    if (!ok) continue;
    // movem.l (a2)+ load opens the block: 52 bytes before the store.
    const load = i - 52;
    if (w16(load) !== 0x4cda || w16(load + 2) !== 0x187e) continue;

    // Walk backward from `load` for the source (a2=src) load — it's the
    // register load immediately preceding the movem block. The dest (a1)
    // load sits BEFORE that (setup order a1 then a2), so capture it in a
    // second pass scanning further back.
    let src = -1;
    let dest = -1;
    let srcOff = -1;
    for (let s = load - 2; s >= load - 16 && s >= 0; s -= 2) {
      const op = w16(s);
      if (s + 6 > instructions.length) continue;
      // movea.l #imm, a2 (src): 0x247c. lea.l abs,a2: 0x45f9.
      if (op === 0x247c || op === 0x45f9) {
        src = W(s + 2);
        srcOff = s;
        break;
      }
    }
    if (src < 0 || srcOff < 0) continue;
    // a1 (dest) load: movea.l #imm,a1 (0x227c) or lea.l abs,a1 (0x43f9),
    // within ~12 bytes before the a2 load.
    for (let s = srcOff - 2; s >= srcOff - 16 && s >= 0; s -= 2) {
      const op = w16(s);
      if (s + 6 > instructions.length) continue;
      if (op === 0x227c || op === 0x43f9) {
        dest = W(s + 2);
        break;
      }
    }

    if (src < 0 || srcOff < 0) continue;
    if (sites.some((s) => s.src === src)) continue;
    sites.push({
      setupOffset: load,
      src,
      copyBytes: 32,
      banks: 1,
      forced: true,
      ...(dest >= 0 ? { dest } : {}),
    });
  }

  return sites;
}

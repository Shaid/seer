/**
 * Generic CPS1/CPS2 "gfx_layout" planar tile decoder.
 *
 * CPS1/CPS2 games store tile/sprite graphics as N-bitplane data addressed
 * by an arbitrary (per-format) bit-offset table rather than a fixed
 * byte-per-plane layout — MAME's `gfx_element::decode()`
 * (`src/emu/drawgfx.cpp`) is the authoritative reference implementation.
 * This is a direct, MSB-first-bit-numbered port of that function (see
 * `readBit()`), parameterised by a `GfxLayout` matching MAME's
 * `gfx_layout` struct field-for-field (`src/emu/digfx.h`).
 *
 * `CPS1_LAYOUT_16X16` below is MAME's `cps1_layout16x16` from
 * `src/mame/capcom/cps1.cpp` — the layout the CPS1/CPS2 "gfx" GFXDECODE
 * entry uses for the 16x16 tiles both CPS1 and CPS2 render (CPS2's video
 * hardware is a superset of CPS1's; the driver shares this decode table).
 * This is a completely generic decoder — no ddsom-specific knowledge.
 */

export interface GfxLayout {
  width: number;
  height: number;
  planes: number;
  /** Bit offset of each bitplane, relative to a tile's own base bit offset. */
  planeOffset: number[];
  /** Bit offset of each horizontal pixel column, added to the plane offset. */
  xOffset: number[];
  /** Bit offset of each vertical pixel row, added to the plane offset. */
  yOffset: number[];
  /** Distance between two consecutive tiles, in bits. */
  charIncrement: number;
}

const STEP8 = (start: number, step: number): number[] =>
  Array.from({ length: 8 }, (_, i) => start + i * step);
const STEP16 = (start: number, step: number): number[] =>
  Array.from({ length: 16 }, (_, i) => start + i * step);

/** MAME's `cps1_layout16x16` (src/mame/capcom/cps1.cpp) — 16x16 tiles, 4bpp, used by the CPS1/CPS2 "gfx" GFXDECODE entry. */
export const CPS1_LAYOUT_16X16: GfxLayout = {
  width: 16,
  height: 16,
  planes: 4,
  planeOffset: [24, 16, 8, 0],
  xOffset: [...STEP8(0, 1), ...STEP8(32, 1)],
  yOffset: STEP16(0, 4 * 16),
  charIncrement: 4 * 16 * 16,
};

/**
 * MAME's `cps1_layout8x8`/`cps1_layout8x8_2` (src/mame/capcom/cps1.cpp,
 * `GFXDECODE_ENTRY` slots 0/1 of `gfx_cps1`) — the 8x8-granularity decode
 * scroll1 (the CPS1 text/UI tilemap layer) actually uses, distinct from
 * `CPS1_LAYOUT_16X16` above (sprites/scroll2). Ported field-for-field from
 * the fetched source (fetched 2026-08-22):
 *
 * ```c
 * static const gfx_layout cps1_layout8x8 = {
 *   8,8, RGN_FRAC(1,1), 4, { 24, 16, 8, 0 }, { STEP8(0, 1) }, { STEP8(0, 4*16) }, 64*8
 * };
 * static const gfx_layout cps1_layout8x8_2 = {
 *   8,8, RGN_FRAC(1,1), 4, { 24, 16, 8, 0 }, { STEP8(32, 1) }, { STEP8(0, 4*16) }, 64*8
 * };
 * ```
 *
 * `charIncrement` (512 bits = 64 bytes) is exactly HALF of
 * `CPS1_LAYOUT_16X16`'s (1024 bits = 128 bytes): a 16x16 tile at 16x16-code
 * `c` is built from the SAME underlying ROM bits as 8x8-addressing codes
 * `2c` (top 8 rows) and `2c+1` (bottom 8 rows) — and, within each of those,
 * `cps1_layout8x8`'s `xOffset` (bits 0-7) gives the LEFT 8 columns while
 * `cps1_layout8x8_2`'s `xOffset` (bits 32-39) gives the RIGHT 8 columns of
 * that same 16-wide row pair. This means the two layouts are two different
 * *views* of one shared code-address space, not two disjoint regions.
 *
 * Which of the two views applies to a given screen tile is NOT a property
 * of the tile code itself — it's selected per screen position by
 * `cps_state::get_tile0_info()`'s `gfxset = BIT(tile_index, 5)`, where
 * `tile_index` is the tilemap position (not the code), and bit 5 of
 * `tile_index = (row&0x1f) + ((col&0x3f)<<5)` reduces to the destination
 * COLUMN's parity (`col & 1`) — confirmed directly from source, matching
 * this driver's own comment: "columns of the 8x8 tilemap alternate between
 * sides of the 16x16 tile". Callers must pick `CPS1_LAYOUT_8X8` for even
 * destination columns and `CPS1_LAYOUT_8X8_2` for odd ones.
 */
export const CPS1_LAYOUT_8X8: GfxLayout = {
  width: 8,
  height: 8,
  planes: 4,
  planeOffset: [24, 16, 8, 0],
  xOffset: STEP8(0, 1),
  yOffset: STEP8(0, 4 * 16),
  charIncrement: 64 * 8,
};

/** The "odd column" sibling of {@link CPS1_LAYOUT_8X8} — see its doc comment. */
export const CPS1_LAYOUT_8X8_2: GfxLayout = {
  width: 8,
  height: 8,
  planes: 4,
  planeOffset: [24, 16, 8, 0],
  xOffset: STEP8(32, 1),
  yOffset: STEP8(0, 4 * 16),
  charIncrement: 64 * 8,
};

/**
 * MAME's `cps1_layout32x32` (src/mame/capcom/cps1.cpp, `GFXDECODE_ENTRY`
 * slot 3 of `gfx_cps1`) — the scroll3 (far-background) layer's own
 * granularity over the same shared "gfx" region. Ported field-for-field
 * from the fetched source (fetched 2026-08-23):
 *
 * ```c
 * static const gfx_layout cps1_layout32x32 = {
 *   32,32, RGN_FRAC(1,1), 4, { 24, 16, 8, 0 },
 *   { STEP8(0,1), STEP8(32,1), STEP8(64,1), STEP8(96,1) },
 *   { STEP32(0, 4*32) }, 4*32*32
 * };
 * ```
 *
 * `charIncrement` (4*32*32 = 4096 bits = 512 bytes) is 4x
 * `CPS1_LAYOUT_16X16`'s (128 bytes): one 32x32 scroll3 tile is
 * built from the same underlying bytes as four consecutive 16x16-numbered
 * tiles' worth of data, laid out as a 2x2 block of 16-pixel quadrants (the
 * `STEP8(0,1),STEP8(32,1),STEP8(64,1),STEP8(96,1)` xOffset covers 4
 * consecutive 8-pixel-wide byte-groups = 32 pixels in one row read).
 */
export const CPS1_LAYOUT_32X32: GfxLayout = {
  width: 32,
  height: 32,
  planes: 4,
  planeOffset: [24, 16, 8, 0],
  xOffset: [...STEP8(0, 1), ...STEP8(32, 1), ...STEP8(64, 1), ...STEP8(96, 1)],
  yOffset: Array.from({ length: 32 }, (_, i) => i * 4 * 32),
  charIncrement: 4 * 32 * 32,
};

/**
 * CPS2's generic `gfxrom_bank_mapper()` (src/mame/capcom/cps1_v.cpp),
 * specialised to the `"cps2"` fallback `CPS1config` table row (`{"cps2",
 * CPS_B_21_DEF, mapper_cps2}` in `cps1_config_table`) — the row every CPS2
 * game not individually listed by name falls back to, which per
 * docs/ddsom/cps2/data-structure.md sec 3.5 includes both ddsom and ddtod.
 *
 * `mapper_cps2`'s `bank_sizes` are `{0x20000, 0x20000, 0, 0}` (in 8x8-tile
 * "1x" units, i.e. bytes/64) and its one `gfx_range` entry is
 * `{ GFXTYPE_SCROLL1|GFXTYPE_SCROLL2|GFXTYPE_SCROLL3, start:0, end:0x1ffff,
 * bank:1 }` — there is no entry at all for `GFXTYPE_SPRITES` (see
 * `cps2SpriteCode()` below for why sprites don't need this function at
 * all on CPS2 hardware). For any raw scroll1/2/3 tilemap "code" value in
 * `[0, 0x1ffff]`, the real formula collapses to:
 *
 * ```c
 * shift = (type==SCROLL1) ? 0 : (type==SCROLL2) ? 1 : 3;  // SCROLL3
 * code <<= shift;
 * base = bank_sizes[0];                      // = 0x20000, since range.bank==1
 * return (base + (code & (bank_sizes[1]-1))) >> shift;
 *      = (0x20000 + (code << shift)) >> shift   // since code<<shift <= 0x1ffff<<shift < bank_sizes[1]
 *      = (0x20000 >> shift) + code
 * ```
 *
 * i.e. every scroll1/2/3 code is simply offset by a **fixed per-layer-type
 * constant** into "bank 1": `+0x20000` in 8x8-code units (scroll1),
 * `+0x10000` in 16x16-code units (scroll2), `+0x4000` in 32x32-code units
 * (scroll3) — all three land on the exact same physical byte range,
 * `gfx[0x800000, 0x1000000)` (`0x20000 * 64 bytes` = `0x10000 * 128 bytes`
 * = `0x4000 * 512 bytes` = `0x800000` bytes, confirmed identical three
 * ways). **Confirmed empirically**: decoding this project's real `gfx`
 * region at the scroll1 8x8 granularity, at exactly this offset (raw code
 * 0 -> physical 8x8-index 0x20000), for raw codes 0-255 renders a fully
 * legible ASCII font, byte-exact-aligned with real ASCII at codes 0x40-0x7f
 * (`@ABCDEFGHIJKLMNO` at 0x40, `PQRSTUVWXYZ[¥]^_` at 0x50, `` `abcdefghijklmno``
 * at 0x60, `pqrstuvwxyz{|}~` at 0x70) — see
 * docs/ddsom/cps2/data-structure.md sec 3.7 for the render and the boss
 * name-draw routine (sec 6.9.1) that writes exactly this raw, unmapped
 * ASCII byte value as a scroll1 tile code with zero other transformation,
 * which is what made this formula worth checking in the first place.
 */
export function cps2ScrollBankMap(
  rawCode: number,
  type: 'scroll1' | 'scroll2' | 'scroll3',
): number {
  const shift = type === 'scroll1' ? 0 : type === 'scroll2' ? 1 : 3;
  return (0x20000 >> shift) + rawCode;
}

/**
 * CPS2's own `cps2_render_sprites()` (src/mame/capcom/cps2.cpp) — CPS2
 * defines its own sprite renderer rather than reusing CPS1's shared
 * `cps_state::cps1_render_sprites()` (confirmed: `cps2_state` overrides
 * `render_layers()`/sprite drawing, unlike scroll1/2/3's tile-info getters
 * which really are unmodified — the "no CPS2 video override exists" claim
 * in docs/ddsom/cps2/data-structure.md sec 3.5/3.6 was correct for the
 * *tilemap* getters but not for sprites). Two consequences, both confirmed
 * from the fetched source (fetched 2026-08-23):
 *
 * 1. **No `gfxrom_bank_mapper()` call at all** — matches
 *    `mapper_cps2_table`'s own source comment, "sprites are not listed
 *    here because they are addressed linearly by the CPS2 sprite code".
 *    A CPS2 sprite's raw OBJ_BASE `code` word (§3.6) needs no remapping:
 *    it addresses `CPS1_LAYOUT_16X16` tile-index space directly.
 * 2. **The raw 16-bit code word alone cannot address all 196,608 tiles**
 *    (18 bits needed). CPS2 steals 2 otherwise-unused high bits of the
 *    sprite's own Y position word for this: `code = base[i+2] +
 *    ((base[i+1] & 0x6000) << 3)` — screen Y coordinates never need bits
 *    13-14 (a 256/384-line screen needs at most 9 bits), so the hardware
 *    repurposes them as tile-code extension bits. This is a genuinely new
 *    finding versus §3.6's original text (which cited the *CPS1* function
 *    signature, `gfxrom_bank_mapper()`, as if CPS2 used it unmodified for
 *    sprites too — it does not).
 */
export function cps2SpriteCode(codeWord: number, yWord: number): number {
  return (codeWord + ((yWord & 0x6000) << 3)) >>> 0;
}

/**
 * Pick the correct 8x8 gfx layout for a scroll1 (or shared CPS1/CPS2
 * `get_tile0_info`-family) tile at destination tilemap column `col` —
 * `cps_state::get_tile0_info()`'s `gfxset = BIT(tile_index, 5)` reduces to
 * `col & 1` (see {@link CPS1_LAYOUT_8X8}'s doc comment for the derivation).
 */
export function scroll1GfxSetForColumn(col: number): GfxLayout {
  return col & 1 ? CPS1_LAYOUT_8X8_2 : CPS1_LAYOUT_8X8;
}

/** MSB-first bit read: `src[bitnum/8]`'s bit `(7 - bitnum%8)`. Matches MAME's `readbit()` in src/emu/drawgfx.cpp exactly. */
function readBit(src: Uint8Array, bitnum: number): boolean {
  const byteIndex = bitnum >>> 3;
  if (byteIndex >= src.length) return false;
  return (src[byteIndex] & (0x80 >> (bitnum & 7))) !== 0;
}

/**
 * Decode tile `code` from `srcdata` (a whole gfx region buffer) per
 * `layout`, returning one palette-index byte per pixel (row-major,
 * `layout.width * layout.height` bytes). A direct port of
 * `gfx_element::decode()`'s inner loop (no `xormask`/dirty-tracking —
 * this always fully decodes).
 */
export function decodeTile(srcdata: Uint8Array, layout: GfxLayout, code: number): Uint8Array {
  const { width, height, planes, planeOffset, xOffset, yOffset, charIncrement } = layout;
  const out = new Uint8Array(width * height);

  for (let plane = 0; plane < planes; plane++) {
    const planeBit = 1 << (planes - 1 - plane);
    const planeoffs = code * charIncrement + planeOffset[plane];
    for (let y = 0; y < height; y++) {
      const yoffs = planeoffs + yOffset[y];
      const rowBase = y * width;
      for (let x = 0; x < width; x++) {
        if (readBit(srcdata, yoffs + xOffset[x])) {
          out[rowBase + x] |= planeBit;
        }
      }
    }
  }
  return out;
}

/** Total number of `layout`-shaped tiles that fit in a region of `regionBytes` bytes. */
export function tileCount(regionBytes: number, layout: GfxLayout): number {
  return Math.floor((regionBytes * 8) / layout.charIncrement);
}

/**
 * Swap two 8-byte ("uint64_t") units of `buf`, at absolute unit indices
 * `a` and `b` (byte offset = unit index * 8).
 */
function swapUnits(buf: Uint8Array, a: number, b: number): void {
  const ao = a * 8;
  const bo = b * 8;
  for (let k = 0; k < 8; k++) {
    const t = buf[ao + k];
    buf[ao + k] = buf[bo + k];
    buf[bo + k] = t;
  }
}

/**
 * Direct port of `cps2_state::unshuffle()` (`src/mame/capcom/cps2.cpp`) —
 * a recursive de-interleave CPS2 applies to its "gfx" region, per
 * 0x200000-byte bank, treating the bank as an array of 8-byte units, that
 * CPS1 does not need. Without it, tiles decode to structured-looking but
 * meaningless noise (confirmed: decoding ddsom's gfx region with the
 * correct `cps1_layout16x16` planar formula but *no* unshuffle produces
 * uniform static, not recognizable art; applying this first fixes it —
 * see docs/ddsom/cps2/data-structure.md § "Tile graphics").
 *
 * `base`/`len` are in 8-byte units, relative to `buf`'s start (mirrors the
 * original's `uint64_t*` pointer arithmetic exactly — do not "simplify"
 * the recursion without re-deriving the index math from the C source).
 */
function unshuffle(buf: Uint8Array, base: number, len: number): void {
  if (len === 2) return;
  if (len % 4 !== 0) throw new Error(`unshuffle: len ${len} must be a multiple of 4`);
  len = len / 2;
  unshuffle(buf, base, len);
  unshuffle(buf, base + len, len);
  const half = len / 2;
  for (let i = 0; i < half; i++) {
    swapUnits(buf, base + half + i, base + len + i);
  }
}

/**
 * Apply CPS2's `cps2_gfx_decode()` bank-wise unshuffle to a raw, assembled
 * "gfx" region (built via `interleaveWords()`), in place. Must be called
 * before `decodeTile()` — see `unshuffle()`'s doc comment.
 */
export function cps2UnshuffleGfx(gfx: Uint8Array, bankSize = 0x200000): void {
  if (gfx.length % bankSize !== 0) {
    throw new Error(
      `cps2UnshuffleGfx: region size ${gfx.length} is not a multiple of bank size ${bankSize}`,
    );
  }
  const unitsPerBank = bankSize / 8;
  for (let bank = 0; bank * bankSize < gfx.length; bank++) {
    unshuffle(gfx, bank * unitsPerBank, unitsPerBank);
  }
}

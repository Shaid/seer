/**
 * Capcom CPS2 board video: a renderer for the virtual board a browser-native
 * reimplementation writes to (ddtod / ddsom and any other CPS2 game). Game
 * logic writes the same memory the 68000 did — the gfx RAM window
 * (SCROLL1/2/3 tilemaps, row-scroll table, palette shadow pages), the CPS-A
 * and CPS-B register blocks, the CPS2 object RAM and its control registers —
 * and this module only turns that state into an indexed 384x224 frame (one
 * palette index 0..0xc00 per pixel) plus the palette -> RGBA conversion.
 * Pure, no platform imports.
 *
 * Hardware facts and where they come from. "DS" = kolbold
 * `docs/ddsom/cps2/data-structure.md` (ddtod's doc repeats §3.5/§3.6); MAME
 * `src/mame/capcom/cps2.cpp` + `cps1_v.cpp` is the prior art the docs cite.
 *
 * From the docs (confirmed there against the games' own code):
 * - Gfx RAM window `0x900000-0x92ffff`; CPS-A registers `0x804100-0x80413f`
 *   (word 0 OBJ_BASE, 1/2/3 SCROLL1/2/3_BASE, 4 OTHER_BASE, 5 PALETTE_BASE,
 *   6/7 SCROLL1 X/Y, 8/9 SCROLL2 X/Y, 10/11 SCROLL3 X/Y, 0x10 ROWSCROLL_OFFS,
 *   0x11 VIDEOCONTROL); a base register `r` addresses `0x900000 | (r*256 &
 *   0x3ffff)` (DS §3.5 table, `cps1_base()`).
 * - CPS-B: layer control `0x804166`, palette control `0x804170` (6 page
 *   enable bits); the priority-mask registers `0x804168-6e` are never written
 *   by either game (DS §6.15.7), so the CPS1 per-pen "high layer" split is
 *   not modelled.
 * - Layer control: back-to-front `l0..l3 = (v >> 6, 8, 10, 12) & 3` with
 *   0 = sprites, 1/2/3 = SCROLL1/2/3; bits 1/2/3 enable SCROLL1/2/3 (DS
 *   §6.15.7, corroborated by the games' "Block Test" captions).
 * - Tilemaps: 2 words per tile `{code, attr}`, 64x64 tiles; SCROLL1 8x8,
 *   SCROLL2 16x16, SCROLL3 32x32; column-major scans `(row&0x1f) + (col<<5)
 *   + ((row&0x20)<<6)`, `(row&0xf) + (col<<4) + ((row&0x30)<<6)`,
 *   `(row&7) + (col<<3) + ((row&0x38)<<6)` (DS §3.6, §6.15.2, §6.16; ddtod
 *   §3.8.1); attr bits 0-4 colour bank inside the layer's palette page
 *   (+0x20/+0x40/+0x60 banks), bit 5 flip X, bit 6 flip Y, bits 7-8 group
 *   (unused on CPS2, see above); pen 15 transparent. Physical tile =
 *   {@link cps2ScrollBankMap}; SCROLL1's 8x8 view alternates between the
 *   left and right half of the 16x16 tile by column parity
 *   ({@link scroll1GfxSetForColumn}).
 * - Scroll registers: the screen's left column is tilemap x `scrollX + 0x40`
 *   (the games write `camera - 0x40`, DS §6.15.7 "the CPS horizontal
 *   offset").
 * - Palette: 6 pages x 0x200 words at PALETTE_BASE (OBJ, SCROLL1, SCROLL2,
 *   SCROLL3, 2 unused here), 0xc00 entries; the CPS-B copies the shadow
 *   pages into the real palette when PALETTE_BASE is (re)written (DS §3.5);
 *   word = brightness nibble + 4-bit R, G, B, decoded with
 *   {@link decodeCps1PaletteWord} (bit layout corroborated by the games'
 *   own fade code masking `0x0fff`, DS §3.5).
 * - CPS2 objects: object RAM `0x708000` (bank switch `0x8040e0` bit 0) as
 *   selected by `0x400000 = 0x7080`; 4 words per object `X, Y, code, attr`;
 *   priority = X bits 13-15; tile code = `code + (Y & 0x6000) << 3`
 *   ({@link cps2SpriteCode}); attr bits 0-4 colour (page 0), 5 flip X,
 *   6 flip Y, 8-11 / 12-15 block width / height - 1 (DS §3.6, §3.8 ddsom
 *   builder `ror.l #3`, ddtod §8.2).
 * - OBJ_PRI (`0x400004`) is loaded per stage from a word table by the
 *   scroll-camera init (ddsom `opcodes+0x2ee00` / `+0x33b48`, ddtod
 *   `+0x58b8a`).
 *
 * Taken from MAME's driver, NOT stated in the docs (flagged at each constant):
 * - the visible window = raster x 64..447, y 16..239 of the 1024x1024 sprite
 *   and tilemap coordinate space ({@link CPS2_VISIBLE_X0}/{@link CPS2_VISIBLE_Y0});
 * - CPS2 fills the screen with black before drawing (`bitmap.fill(black_pen)`),
 *   modelled as the extra palette index {@link CPS2_BACKDROP_PEN};
 * - draw order and the sprite priority masks of `cps2_state::render_layers()`
 *   and `cps2_render_sprites()` (list end marker `Y >= 0x8000 || attr >=
 *   0xff00`, drawn from the last entry back to entry 0, each opaque sprite
 *   pixel then blocks later ones: the LAST list entry is frontmost), the
 *   object offsets `x + 64 - OBJ_XOFFS`, `y + 16 - OBJ_YOFFS`, attr bit 7
 *   (relative to the offset registers), the block-sprite tile walk, and the
 *   vblank latch of the object list and OBJ_PRI (`cps2_objram_latch`);
 * - SCROLL2 row scroll (VIDEOCONTROL bit 0; per-line X from the OTHER_BASE
 *   table indexed by `line + ROWSCROLL_OFFS`) — the games do use it (DS
 *   §6.15.7) but its exact indexing is MAME's;
 * - base-register alignment (scroll 0x4000, other 0x800, palette 0x400 bytes)
 *   and palette-control page skipping (`cps1_build_palette`).
 * Not modelled: flip screen (VIDEOCONTROL bit 15), CPS1-style sprites in a
 * layer slot (layer code 0 left in l0..l2), the stars layers, raster effects.
 */

import { CPS1_LAYOUT_16X16, CPS1_LAYOUT_32X32, CPS1_LAYOUT_8X8, CPS1_LAYOUT_8X8_2, cps2ScrollBankMap, cps2SpriteCode, decodeTile, type GfxLayout } from './gfx.js';
import { decodeCps1PaletteWord } from './palette.js';

export const CPS2_SCREEN_WIDTH = 384;
export const CPS2_SCREEN_HEIGHT = 224;
/** First visible column / line of the 1024x1024 sprite and tilemap coordinate space (MAME `CPS_HBEND` / `CPS_VBEND`). */
export const CPS2_VISIBLE_X0 = 64;
export const CPS2_VISIBLE_Y0 = 16;
/** Frame rate of MAME's CPS1/CPS2 screen (8 MHz pixel clock, 512 x 262 total); the kolbold docs do not state it. */
export const CPS2_HZ = 8_000_000 / (512 * 262);

/** Gfx RAM window on the 68000 bus (DS §3.5). */
export const CPS2_GFXRAM_ADDR = 0x900000;
export const CPS2_GFXRAM_SIZE = 0x30000;
export const CPS2_CPSA_ADDR = 0x804100;
export const CPS2_CPSB_ADDR = 0x804140;
/** CPS2 object control registers (`0x400000-0x40000b`). */
export const CPS2_OUTPUT_ADDR = 0x400000;
export const CPS2_OBJRAM1_ADDR = 0x700000;
export const CPS2_OBJRAM2_ADDR = 0x708000;
export const CPS2_OBJRAM_BANK_ADDR = 0x8040e0;
/** Bytes per object RAM bank: 1024 objects of 4 words. */
export const CPS2_OBJRAM_SIZE = 0x2000;
export const CPS2_OBJ_COUNT = 0x400;

/** CPS-A word registers (index = byte offset / 2), MAME `cps1.h` names as quoted in DS §3.5. */
export const CPS_A = {
  OBJ_BASE: 0x00,
  SCROLL1_BASE: 0x01,
  SCROLL2_BASE: 0x02,
  SCROLL3_BASE: 0x03,
  OTHER_BASE: 0x04,
  PALETTE_BASE: 0x05,
  SCROLL1_X: 0x06,
  SCROLL1_Y: 0x07,
  SCROLL2_X: 0x08,
  SCROLL2_Y: 0x09,
  SCROLL3_X: 0x0a,
  SCROLL3_Y: 0x0b,
  ROWSCROLL_OFFS: 0x10,
  VIDEOCONTROL: 0x11,
} as const;
/** CPS-B word registers of the CPS2 (`CPS_B_21_DEF`) configuration (DS §3.5, §6.15.7). */
export const CPS_B = {
  LAYER_CONTROL: 0x26 >> 1,
  PALETTE_CONTROL: 0x30 >> 1,
} as const;
/** CPS2 object control word registers at `0x400000` (MAME `CPS2_OBJ_*`). */
export const CPS2_OBJ = { BASE: 0, UNK1: 1, PRI: 2, UNK2: 3, XOFFS: 4, YOFFS: 5 } as const;

/** Palette pages of 0x200 entries: 0 OBJ, 1 SCROLL1, 2 SCROLL2, 3 SCROLL3 (DS §3.5/§3.6). */
export const CPS2_PALETTE_PAGES = 6;
export const CPS2_PALETTE_ENTRIES = 0xc00;
/** Index past the real palette: the black the hardware clears to (MAME). {@link cps2PaletteToRgba} emits it as entry 0xc00. */
export const CPS2_BACKDROP_PEN = 0xc00;
export const CPS2_PALETTE_RGBA_ENTRIES = CPS2_PALETTE_ENTRIES + 1;

const GFXRAM_WORDS = 0x20000; // 0x3ffff-byte reach of a base register; only 0x30000 bytes are on the bus
const SCROLL_ALIGN = 0x4000;
const OTHER_ALIGN = 0x800;
const PALETTE_ALIGN = 0x400;
const TRANSPARENT_PEN = 15;
const OBJ_WORDS = CPS2_OBJRAM_SIZE / 2;
/** Priority-bitmap value MAME writes for every opaque sprite pixel (blocks later sprites). */
const PRI_SPRITE = 31;

/**
 * Decoded CPS2 graphics, one pen (0-15) per pixel, row-major, looked up by
 * PHYSICAL tile code (after {@link cps2ScrollBankMap} / {@link cps2SpriteCode}).
 * `null` = tile not available: drawn fully transparent (the way MAME draws an
 * out-of-range code). Lets a port ship only the tiles it needs.
 */
export interface Cps2Gfx {
  /** 8x8 tile `code` in the 8x8 code space; `set` 0 = `CPS1_LAYOUT_8X8` (left half), 1 = `_8X8_2` (right half). 64 pens. */
  tile8(code: number, set: number): Uint8Array | null;
  /** 16x16 tile (SCROLL2 and sprites). 256 pens. */
  tile16(code: number): Uint8Array | null;
  /** 32x32 tile (SCROLL3). 1024 pens. */
  tile32(code: number): Uint8Array | null;
}

/** {@link Cps2Gfx} decoding lazily from a whole unshuffled CPS2 gfx region (`cps2UnshuffleGfx`); caches every tile it decodes. */
export class Cps2GfxRegion implements Cps2Gfx {
  private readonly region: Uint8Array;
  private readonly cache8 = new Map<number, Uint8Array | null>();
  private readonly cache16 = new Map<number, Uint8Array | null>();
  private readonly cache32 = new Map<number, Uint8Array | null>();

  constructor(region: Uint8Array) {
    this.region = region;
  }

  private get(cache: Map<number, Uint8Array | null>, key: number, layout: GfxLayout, code: number): Uint8Array | null {
    let t = cache.get(key);
    if (t === undefined) {
      t = code >= 0 && (code + 1) * (layout.charIncrement / 8) <= this.region.length ? decodeTile(this.region, layout, code) : null;
      cache.set(key, t);
    }
    return t;
  }

  tile8(code: number, set: number): Uint8Array | null {
    return this.get(this.cache8, code * 2 + (set & 1), set & 1 ? CPS1_LAYOUT_8X8_2 : CPS1_LAYOUT_8X8, code);
  }
  tile16(code: number): Uint8Array | null {
    return this.get(this.cache16, code, CPS1_LAYOUT_16X16, code);
  }
  tile32(code: number): Uint8Array | null {
    return this.get(this.cache32, code, CPS1_LAYOUT_32X32, code);
  }
}

/** One granularity of a {@link Cps2PackedGfx}: `codes[i]` is stored at `pens[i * size * size]`. 8x8 keys are `code * 2 + set`. */
export interface Cps2TileTable {
  codes: ArrayLike<number>;
  pens: Uint8Array;
}

/** {@link Cps2Gfx} over a sparse set of pre-decoded tiles (what a port ships). Missing tiles are transparent. */
export class Cps2PackedGfx implements Cps2Gfx {
  private readonly t8: Map<number, Uint8Array>;
  private readonly t16: Map<number, Uint8Array>;
  private readonly t32: Map<number, Uint8Array>;

  constructor(tables: { tile8?: Cps2TileTable; tile16?: Cps2TileTable; tile32?: Cps2TileTable }) {
    this.t8 = Cps2PackedGfx.index(tables.tile8, 64);
    this.t16 = Cps2PackedGfx.index(tables.tile16, 256);
    this.t32 = Cps2PackedGfx.index(tables.tile32, 1024);
  }

  private static index(t: Cps2TileTable | undefined, n: number): Map<number, Uint8Array> {
    const m = new Map<number, Uint8Array>();
    if (!t) return m;
    if (t.pens.length < t.codes.length * n) throw new Error(`Cps2PackedGfx: ${t.codes.length} tiles need ${t.codes.length * n} pens, got ${t.pens.length}`);
    for (let i = 0; i < t.codes.length; i++) m.set(t.codes[i], t.pens.subarray(i * n, (i + 1) * n));
    return m;
  }

  get counts(): { tile8: number; tile16: number; tile32: number } {
    return { tile8: this.t8.size, tile16: this.t16.size, tile32: this.t32.size };
  }
  tile8(code: number, set: number): Uint8Array | null {
    return this.t8.get(code * 2 + (set & 1)) ?? null;
  }
  tile16(code: number): Uint8Array | null {
    return this.t16.get(code) ?? null;
  }
  tile32(code: number): Uint8Array | null {
    return this.t32.get(code) ?? null;
  }
}

/** Everything the video hardware reads in one frame (views, no copies). */
export interface Cps2BoardState {
  /** Gfx RAM as words, index = (bus address - 0x900000) / 2; sized for a base register's full 0x3ffff-byte reach. */
  gfxRam: Uint16Array;
  /** CPS-A registers, 0x20 words ({@link CPS_A}). */
  cpsA: Uint16Array;
  /** CPS-B registers, 0x20 words ({@link CPS_B}). */
  cpsB: Uint16Array;
  /** The object list the hardware draws (latched at vblank), 0x1000 words. */
  objList: Uint16Array;
  /** CPS2 object control registers, 6 words ({@link CPS2_OBJ}). */
  objOutput: Uint16Array;
  /** OBJ_PRI as latched at vblank. */
  priCtrl: number;
  /** The real palette (0xc00 words) as last uploaded by a PALETTE_BASE write. */
  palette: Uint16Array;
}

export interface Cps2Frame {
  width: number;
  height: number;
  /** Palette index (0..0xc00) per pixel, row-major. */
  pixels: Uint16Array;
}

export type Cps2LayerCode = 0 | 1 | 2 | 3;

/** The layer-control word decoded: back-to-front layer codes (0 = sprites, 1-3 = SCROLL1-3) and the SCROLL enables (DS §6.15.7). */
export function decodeCps2LayerControl(word: number): { order: [Cps2LayerCode, Cps2LayerCode, Cps2LayerCode, Cps2LayerCode]; scroll1: boolean; scroll2: boolean; scroll3: boolean } {
  const order = [6, 8, 10, 12].map((s) => ((word >> s) & 3) as Cps2LayerCode) as [Cps2LayerCode, Cps2LayerCode, Cps2LayerCode, Cps2LayerCode];
  return { order, scroll1: (word & 2) !== 0, scroll2: (word & 4) !== 0, scroll3: (word & 8) !== 0 };
}

/**
 * MAME `cps2_state::render_layers()`: the three tilemap layers left after
 * taking the sprite code out of the back-to-front order, and the eight sprite
 * priority masks (bit `v` set = a pixel whose layer-coverage value is `v`
 * hides a sprite of that priority; coverage bits 1/2/4 = back/middle/front
 * tilemap opaque).
 */
export function cps2LayerPlan(layerControl: number, priCtrl: number): { layers: [number, number, number]; primasks: Uint32Array } {
  let [l0, l1, l2, l3] = decodeCps2LayerControl(layerControl).order as number[];
  let l0pri = (priCtrl >> (4 * l0)) & 0xf;
  let l1pri = (priCtrl >> (4 * l1)) & 0xf;
  let l2pri = (priCtrl >> (4 * l2)) & 0xf;
  const l3pri = (priCtrl >> (4 * l3)) & 0xf;
  if (l0 === 0) {
    l0 = l1;
    l1 = 0;
    l0pri = l1pri;
  }
  if (l1 === 0) {
    l1 = l2;
    l2 = 0;
    l1pri = l2pri;
  }
  if (l2 === 0) {
    l2 = l3;
    l3 = 0;
    l2pri = l3pri;
  }
  let mask0 = 0xaa;
  let mask1 = 0xcc;
  if (l0pri > l1pri) mask0 &= ~0x88;
  if (l0pri > l2pri) mask0 &= ~0xa0;
  if (l1pri > l2pri) mask1 &= ~0xc0;
  const primasks = new Uint32Array(8);
  primasks[0] = 0xff;
  for (let i = 1; i < 8; i++) {
    if (i <= l0pri && i <= l1pri && i <= l2pri) {
      primasks[i] = 0xfe;
      continue;
    }
    let m = 0;
    if (i <= l0pri) m |= mask0;
    if (i <= l1pri) m |= mask1;
    if (i <= l2pri) m |= 0xf0;
    primasks[i] = m;
  }
  return { layers: [l0, l1, l2], primasks };
}

/** Word index into gfx RAM of a CPS-A base register (`cps1_base()`: `reg * 256 & 0x3ffff`, aligned down). */
export function cps2BaseWord(reg: number, align: number): number {
  return (((reg * 256) & 0x3ffff) & ~(align - 1)) >>> 1;
}

/** Tilemap RAM word offset (of the code word) for tile (col,row) of SCROLL`layer` (MAME `tilemap0/1/2_scan`). */
export function cps2TilemapIndex(layer: 1 | 2 | 3, col: number, row: number): number {
  const c = col & 0x3f;
  if (layer === 1) return (row & 0x1f) + (c << 5) + ((row & 0x20) << 6);
  if (layer === 2) return (row & 0x0f) + (c << 4) + ((row & 0x30) << 6);
  return (row & 0x07) + (c << 3) + ((row & 0x38) << 6);
}

/** One palette word -> `[r, g, b]` (brightness nibble + RGB, `decodeCps1PaletteWord`). */
export function decodeCps2PaletteWord(word: number): [number, number, number] {
  const c = decodeCps1PaletteWord(word & 0xffff);
  return [c.r, c.g, c.b];
}

/** Palette (0xc00 words) -> 0xc01 x RGBA (alpha 255); entry 0xc00 is the black backdrop. */
export function cps2PaletteToRgba(palette: Uint16Array, out: Uint8Array = new Uint8Array(CPS2_PALETTE_RGBA_ENTRIES * 4)): Uint8Array {
  if (palette.length < CPS2_PALETTE_ENTRIES) throw new Error(`cps2 palette must hold ${CPS2_PALETTE_ENTRIES} words`);
  if (out.length < CPS2_PALETTE_RGBA_ENTRIES * 4) throw new Error('cps2 palette RGBA buffer too small');
  const memo = new Map<number, number>();
  for (let i = 0; i < CPS2_PALETTE_ENTRIES; i++) {
    const w = palette[i];
    let rgb = memo.get(w);
    if (rgb === undefined) {
      const [r, g, b] = decodeCps2PaletteWord(w);
      rgb = (r << 16) | (g << 8) | b;
      memo.set(w, rgb);
    }
    out[i * 4] = rgb >> 16;
    out[i * 4 + 1] = (rgb >> 8) & 0xff;
    out[i * 4 + 2] = rgb & 0xff;
    out[i * 4 + 3] = 255;
  }
  const o = CPS2_BACKDROP_PEN * 4;
  out[o] = 0;
  out[o + 1] = 0;
  out[o + 2] = 0;
  out[o + 3] = 255;
  return out;
}

/** Indexed frame + RGBA palette -> RGBA pixels. */
export function cps2FrameToRgba(frame: Cps2Frame, paletteRgba: Uint8Array, out: Uint8Array = new Uint8Array(frame.width * frame.height * 4)): Uint8Array {
  const px = frame.pixels;
  for (let i = 0; i < px.length; i++) {
    const s = px[i] * 4;
    const d = i * 4;
    out[d] = paletteRgba[s];
    out[d + 1] = paletteRgba[s + 1];
    out[d + 2] = paletteRgba[s + 2];
    out[d + 3] = paletteRgba[s + 3];
  }
  return out;
}

/** Layer-render toggles on top of the hardware enables (a debug/viewer aid, not a hardware feature). */
export interface Cps2RenderMask {
  scroll1: boolean;
  scroll2: boolean;
  scroll3: boolean;
  sprites: boolean;
}

const ALL_LAYERS: Cps2RenderMask = { scroll1: true, scroll2: true, scroll3: true, sprites: true };

/**
 * Stateless renderer: board state -> indexed frame. Holds the gfx source and
 * scratch buffers; per-frame work is only the compositing.
 */
export class Cps2Renderer {
  private readonly gfx: Cps2Gfx;
  /** MAME's screen priority bitmap: tilemap coverage bits 1/2/4, 31 = sprite drawn. */
  private readonly pri = new Uint8Array(CPS2_SCREEN_WIDTH * CPS2_SCREEN_HEIGHT);

  constructor(gfx: Cps2Gfx) {
    this.gfx = gfx;
  }

  render(state: Cps2BoardState, out?: Cps2Frame, mask: Cps2RenderMask = ALL_LAYERS): Cps2Frame {
    const W = CPS2_SCREEN_WIDTH;
    const H = CPS2_SCREEN_HEIGHT;
    const frame = out ?? { width: W, height: H, pixels: new Uint16Array(W * H) };
    if (frame.width !== W || frame.height !== H || frame.pixels.length < W * H) throw new Error('cps2 frame must be 384x224');
    frame.pixels.fill(CPS2_BACKDROP_PEN);
    this.pri.fill(0);
    const lc = state.cpsB[CPS_B.LAYER_CONTROL];
    const en = decodeCps2LayerControl(lc);
    const plan = cps2LayerPlan(lc, state.priCtrl);
    const bits = [1, 2, 4];
    for (let i = 0; i < 3; i++) {
      const layer = plan.layers[i];
      if (layer === 1 && en.scroll1 && mask.scroll1) this.drawTilemap(state, 1, bits[i], frame.pixels);
      else if (layer === 2 && en.scroll2 && mask.scroll2) this.drawTilemap(state, 2, bits[i], frame.pixels);
      else if (layer === 3 && en.scroll3 && mask.scroll3) this.drawTilemap(state, 3, bits[i], frame.pixels);
      // layer 0 left in a slot = CPS1-style sprites from OBJ_BASE: not modelled on CPS2 (see the module comment)
    }
    if (mask.sprites) this.drawSprites(state, plan.primasks, frame.pixels);
    return frame;
  }

  private drawTilemap(state: Cps2BoardState, layer: 1 | 2 | 3, primask: number, px: Uint16Array): void {
    const W = CPS2_SCREEN_WIDTH;
    const H = CPS2_SCREEN_HEIGHT;
    const { gfxRam, cpsA } = state;
    const pri = this.pri;
    const gfx = this.gfx;
    const shift = layer === 1 ? 3 : layer === 2 ? 4 : 5;
    const size = 1 << shift;
    const sub = size - 1;
    const mapMask = 64 * size - 1;
    const base = cps2BaseWord(cpsA[CPS_A.SCROLL1_BASE + layer - 1], SCROLL_ALIGN);
    const scrollX = cpsA[CPS_A.SCROLL1_X + 2 * (layer - 1)];
    const scrollY = cpsA[CPS_A.SCROLL1_Y + 2 * (layer - 1)];
    const colourBase = 0x20 * layer * 16;
    const type = layer === 1 ? 'scroll1' : layer === 2 ? 'scroll2' : 'scroll3';
    // SCROLL2 row scroll (MAME): line i of the 256-line raster takes X scroll scroll2x + other[(i + ROWSCROLL_OFFS) & 0x3ff]
    const rowScroll = layer === 2 && (cpsA[CPS_A.VIDEOCONTROL] & 1) !== 0;
    const otherBase = cps2BaseWord(cpsA[CPS_A.OTHER_BASE], OTHER_ALIGN);
    const otherOffs = cpsA[CPS_A.ROWSCROLL_OFFS];

    for (let y = 0; y < H; y++) {
      const line = y + CPS2_VISIBLE_Y0;
      const ty = (line + scrollY) & mapMask;
      const row = ty >> shift;
      const inY = ty & sub;
      const sx = rowScroll ? scrollX + gfxRam[(otherBase + ((line + otherOffs) & 0x3ff)) & (GFXRAM_WORDS - 1)] : scrollX;
      const o = y * W;
      let lastCol = -1;
      let pens: Uint8Array | null = null;
      let rowOff = 0;
      let flipX = false;
      let colour = 0;
      for (let x = 0; x < W; x++) {
        const tx = (x + CPS2_VISIBLE_X0 + sx) & mapMask;
        const col = tx >> shift;
        if (col !== lastCol) {
          lastCol = col;
          const wi = (base + 2 * cps2TilemapIndex(layer, col, row)) & (GFXRAM_WORDS - 1);
          const code = gfxRam[wi];
          const attr = gfxRam[(wi + 1) & (GFXRAM_WORDS - 1)];
          const phys = cps2ScrollBankMap(code, type);
          pens = layer === 1 ? gfx.tile8(phys, col & 1) : layer === 2 ? gfx.tile16(phys) : gfx.tile32(phys);
          flipX = (attr & 0x20) !== 0;
          rowOff = ((attr & 0x40) !== 0 ? sub - inY : inY) * size;
          colour = colourBase + (attr & 0x1f) * 16;
        }
        if (!pens) continue;
        const ix = tx & sub;
        const pen = pens[rowOff + (flipX ? sub - ix : ix)];
        if (pen === TRANSPARENT_PEN) continue;
        px[o + x] = colour + pen;
        pri[o + x] |= primask;
      }
    }
  }

  /** MAME `find_last_sprite()`: index (in words) of the last object before the end marker, -4 when the list is empty. */
  static lastObjectWord(list: Uint16Array): number {
    for (let i = 0; i < OBJ_WORDS; i += 4) {
      if (list[i + 1] >= 0x8000 || list[i + 3] >= 0xff00) return i - 4;
    }
    return OBJ_WORDS - 4;
  }

  private drawSprites(state: Cps2BoardState, primasks: Uint32Array, px: Uint16Array): void {
    const list = state.objList;
    const xoffs = 64 - state.objOutput[CPS2_OBJ.XOFFS];
    const yoffs = 16 - state.objOutput[CPS2_OBJ.YOFFS];
    for (let i = Cps2Renderer.lastObjectWord(list); i >= 0; i -= 4) {
      let x = list[i];
      let y = list[i + 1];
      const priority = (x >> 13) & 7;
      const code = cps2SpriteCode(list[i + 2], y);
      const colour = list[i + 3];
      const col = colour & 0x1f;
      const flipX = (colour & 0x20) !== 0;
      const flipY = (colour & 0x40) !== 0;
      const pmask = primasks[priority];
      if (colour & 0x80) {
        x += state.objOutput[CPS2_OBJ.XOFFS];
        y += state.objOutput[CPS2_OBJ.YOFFS];
      }
      if (colour & 0xff00) {
        const nx = ((colour >> 8) & 0xf) + 1;
        const ny = ((colour >> 12) & 0xf) + 1;
        for (let nys = 0; nys < ny; nys++) {
          const sy = (y + nys * 16 + yoffs) & 0x3ff;
          for (let nxs = 0; nxs < nx; nxs++) {
            const sx = (x + nxs * 16 + xoffs) & 0x3ff;
            const rowStep = 0x10 * (flipY ? ny - 1 - nys : nys);
            // MAME's block walk: the unflipped case wraps within the 16-code row ("pgear fix"), the flipped ones do not
            const c = flipX ? code + (nx - 1) - nxs + rowStep : flipY ? code + nxs + rowStep : (code & ~0xf) + ((code + nxs) & 0xf) + rowStep;
            this.drawSprite(c, col, flipX, flipY, sx, sy, pmask, px);
          }
        }
      } else {
        this.drawSprite(code, col, flipX, flipY, (x + xoffs) & 0x3ff, (y + yoffs) & 0x3ff, pmask, px);
      }
    }
  }

  /** MAME `prio_transpen`: an opaque pen is drawn where `(1 << pri) & pmask` is clear, and always marks the pixel 31. */
  private drawSprite(code: number, col: number, flipX: boolean, flipY: boolean, bx: number, by: number, pmask: number, px: Uint16Array): void {
    const pens = this.gfx.tile16(code);
    if (!pens) return;
    const W = CPS2_SCREEN_WIDTH;
    const H = CPS2_SCREEN_HEIGHT;
    const pri = this.pri;
    const colour = col * 16;
    for (let r = 0; r < 16; r++) {
      const y = by + r - CPS2_VISIBLE_Y0;
      if (y < 0 || y >= H) continue;
      const srcRow = (flipY ? 15 - r : r) * 16;
      for (let c = 0; c < 16; c++) {
        const x = bx + c - CPS2_VISIBLE_X0;
        if (x < 0 || x >= W) continue;
        const pen = pens[srcRow + (flipX ? 15 - c : c)];
        if (pen === TRANSPARENT_PEN) continue;
        const o = y * W + x;
        const p = pri[o];
        if (p !== PRI_SPRITE && ((pmask >>> p) & 1) === 0) px[o] = colour + pen;
        pri[o] = PRI_SPRITE;
      }
    }
  }
}

/**
 * The video side of the virtual board: the RAMs and registers game logic
 * writes over the 68000 bus, the vblank object/priority latch, the CPS-B
 * palette upload, and the renderer.
 */
export class Cps2Video {
  /** Gfx RAM as words (index = (addr - 0x900000) / 2); writable on the bus for 0x900000-0x92ffff. */
  readonly gfxRam = new Uint16Array(GFXRAM_WORDS);
  readonly cpsA = new Uint16Array(0x20);
  readonly cpsB = new Uint16Array(0x20);
  /** CPS2 object control registers `0x400000-0x40000b`. */
  readonly objOutput = new Uint16Array(6);
  /** Object RAM banks 0/1 (MAME `objram1`/`objram2`). */
  readonly objRam: [Uint16Array, Uint16Array] = [new Uint16Array(OBJ_WORDS), new Uint16Array(OBJ_WORDS)];
  /** `0x8040e0` bit 0. */
  objRamBank = 0;
  /** The list the hardware draws, latched by {@link vblank}. */
  readonly objList = new Uint16Array(OBJ_WORDS);
  /** OBJ_PRI as latched by {@link vblank}. */
  priCtrl = 0;
  /** The real palette, written by the CPS-B upload on a PALETTE_BASE write. */
  readonly palette = new Uint16Array(CPS2_PALETTE_ENTRIES);
  /** Viewer/debug layer toggles applied on top of the hardware enables. */
  readonly renderMask: Cps2RenderMask = { ...ALL_LAYERS };

  private readonly renderer: Cps2Renderer;

  constructor(gfx: Cps2Gfx) {
    this.renderer = new Cps2Renderer(gfx);
  }

  /** 68000 word write to a video address; returns false for addresses this board part does not own. */
  write16(addr: number, value: number): boolean {
    const v = value & 0xffff;
    const a = addr & 0xfffffe;
    if (a >= CPS2_GFXRAM_ADDR && a < CPS2_GFXRAM_ADDR + CPS2_GFXRAM_SIZE) {
      this.gfxRam[(a - CPS2_GFXRAM_ADDR) >> 1] = v;
    } else if (a >= CPS2_CPSA_ADDR && a < CPS2_CPSA_ADDR + 0x40) {
      const r = (a - CPS2_CPSA_ADDR) >> 1;
      this.cpsA[r] = v;
      if (r === CPS_A.PALETTE_BASE) this.uploadPalette();
    } else if (a >= CPS2_CPSB_ADDR && a < CPS2_CPSB_ADDR + 0x40) {
      this.cpsB[(a - CPS2_CPSB_ADDR) >> 1] = v;
    } else if (a >= CPS2_OUTPUT_ADDR && a < CPS2_OUTPUT_ADDR + 12) {
      this.objOutput[(a - CPS2_OUTPUT_ADDR) >> 1] = v;
    } else if (a >= CPS2_OBJRAM1_ADDR && a < CPS2_OBJRAM1_ADDR + CPS2_OBJRAM_SIZE) {
      this.objRam[this.objRamBank ^ 0][(a - CPS2_OBJRAM1_ADDR) >> 1] = v;
    } else if (a >= CPS2_OBJRAM2_ADDR && a < CPS2_OBJRAM2_ADDR + 0x8000) {
      // 0x708000-0x709fff, mirrored through 0x70ffff (MAME `mirror(0x006000)`)
      this.objRam[this.objRamBank ^ 1][((a - CPS2_OBJRAM2_ADDR) & (CPS2_OBJRAM_SIZE - 1)) >> 1] = v;
    } else if (a === CPS2_OBJRAM_BANK_ADDR) {
      this.objRamBank = v & 1;
    } else return false;
    return true;
  }

  /** 68000 word read of gfx RAM, the registers or object RAM; `undefined` for addresses this part does not own. */
  read16(addr: number): number | undefined {
    const a = addr & 0xfffffe;
    if (a >= CPS2_GFXRAM_ADDR && a < CPS2_GFXRAM_ADDR + CPS2_GFXRAM_SIZE) return this.gfxRam[(a - CPS2_GFXRAM_ADDR) >> 1];
    if (a >= CPS2_CPSA_ADDR && a < CPS2_CPSA_ADDR + 0x40) return this.cpsA[(a - CPS2_CPSA_ADDR) >> 1];
    if (a >= CPS2_CPSB_ADDR && a < CPS2_CPSB_ADDR + 0x40) return this.cpsB[(a - CPS2_CPSB_ADDR) >> 1];
    if (a >= CPS2_OUTPUT_ADDR && a < CPS2_OUTPUT_ADDR + 12) return this.objOutput[(a - CPS2_OUTPUT_ADDR) >> 1];
    if (a >= CPS2_OBJRAM2_ADDR && a < CPS2_OBJRAM2_ADDR + 0x8000) return this.objRam[this.objRamBank ^ 1][((a - CPS2_OBJRAM2_ADDR) & (CPS2_OBJRAM_SIZE - 1)) >> 1];
    return undefined;
  }

  /** Write `words` big-endian-decoded words starting at bus address `addr` (a block copy, e.g. a tilemap page). */
  writeWords(addr: number, words: ArrayLike<number>): void {
    for (let i = 0; i < words.length; i++) this.write16(addr + 2 * i, words[i]);
  }

  /**
   * CPS-B palette upload (DS §3.5: a PALETTE_BASE write copies the shadow
   * pages into the real palette). Page skipping per MAME `cps1_build_palette`:
   * pages whose palette-control bit is clear are not copied, and once a page
   * has been copied every skipped page also skips its source.
   */
  uploadPalette(): void {
    const ctrl = this.cpsB[CPS_B.PALETTE_CONTROL];
    let src = cps2BaseWord(this.cpsA[CPS_A.PALETTE_BASE], PALETTE_ALIGN);
    const start = src;
    for (let page = 0; page < CPS2_PALETTE_PAGES; page++) {
      if ((ctrl >> page) & 1) {
        for (let i = 0; i < 0x200; i++) this.palette[page * 0x200 + i] = this.gfxRam[(src + i) & (GFXRAM_WORDS - 1)];
        src += 0x200;
      } else if (src !== start) src += 0x200;
    }
  }

  /** Vblank: latch the displayed object RAM bank into the drawn list, and OBJ_PRI (MAME `cps2_objram_latch`). */
  vblank(): void {
    this.priCtrl = this.objOutput[CPS2_OBJ.PRI];
    this.objList.set(this.objRam[this.objRamBank & 1 ? 1 : 0]);
  }

  /** The state snapshot the renderer reads (shares the buffers). */
  state(): Cps2BoardState {
    return {
      gfxRam: this.gfxRam,
      cpsA: this.cpsA,
      cpsB: this.cpsB,
      objList: this.objList,
      objOutput: this.objOutput,
      priCtrl: this.priCtrl,
      palette: this.palette,
    };
  }

  render(out?: Cps2Frame): Cps2Frame {
    return this.renderer.render(this.state(), out, this.renderMask);
  }

  paletteRgba(out?: Uint8Array): Uint8Array {
    return cps2PaletteToRgba(this.palette, out);
  }
}

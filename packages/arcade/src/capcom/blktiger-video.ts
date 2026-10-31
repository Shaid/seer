/**
 * Black Tiger (Capcom, 1987) board video: a renderer for the virtual board a
 * browser-native reimplementation writes to. Game logic fills tile RAM, the
 * sprite list, palette RAM and the scroll/layout/enable registers exactly as
 * the original Z80 code did; this module only turns that state into an
 * indexed 256x224 frame (one palette-RAM index 0..1023 per pixel) plus the
 * palette-RAM -> RGBA conversion. Pure, no platform imports.
 *
 * Hardware facts and where they come from (kolbold
 * `docs/blktiger/arcade/data-structure.md`, "DS" below; MAME
 * `src/mame/capcom/blktiger.cpp` / `blktiger_v.cpp` is the prior art the doc
 * itself cites):
 *
 * - bg tile RAM: 0x4000 bytes = 4 banks of 0x1000 seen through the Z80
 *   window 0xc000-0xcfff, bank chosen by port 0x0d (DS §2 memory/I/O map).
 *   Tile `i` is `[code, attr]` at `[2i, 2i+1]`; `code = byte | (attr&7)<<8`,
 *   colour group `(attr>>3)&0xf`, flip X `attr&0x80` (DS §3.4, §8.1).
 * - Layout (port 0x0e byte): non-zero = 8x4 pages, 128x64 tiles; zero = 4x8
 *   pages, 64x128 tiles; scan formulas DS §8.1. The map wraps in both axes
 *   (2048x1024 or 1024x2048 px torus, DS §8.5 "No camera clamp").
 * - Scroll: 16-bit X/Y, ports 0x08/0x09 (X lo/hi) and 0x0a/0x0b (Y lo/hi)
 *   (DS §2 I/O map; scroll X/Y = mem e030/e032, DS §8.3).
 * - Text layer: 0xd000-0xd7ff, codes at +0, attrs at +0x400;
 *   `code = byte + (attr&0xe0)<<3`, colour `attr&0x1f` (DS §3.4). 8x8 2bpp.
 * - Sprite RAM: 0xfe00-0xffff = 128 x 4 bytes `(code, attr, y, x)`, buffered
 *   (DS §2 memory map, §3.4): `code = b0 | (attr&0xe0)<<3`, colour `attr&7`,
 *   flip X `attr&8`, `x = b3 - (attr&0x10)<<4`, `y = b2`. Pen 15 transparent
 *   (DS §3.6).
 * - Palette: 1024 entries, low byte at 0xd800+i, high byte at 0xdc00+i;
 *   R = lo>>4, G = lo&15, B = hi&15, each nibble-replicated (DS §4).
 *   Bases: tiles 0x000 (16 groups x 16), sprites 0x200 (8 x 16), chars 0x300
 *   (32 x 4); the screen is filled with pen 1023 first (backdrop, DS §4.1 1).
 * - bg-vs-sprite priority per pixel: `p = bd02[(group>>1)<<5] & 3` feeds
 *   bd01 address bits 5:4, the bg pen bits 3:0, bit 6 set; bd01 output 9 =
 *   bg pixel behind sprites, 2 = in front (DS §5.2, §5.5; equal to MAME's
 *   `split_table` + `set_transmask` for all 256 group/pen cells).
 *
 * Taken from MAME's driver, NOT stated in DS (flagged; see the constants):
 * - draw order backdrop -> bg back half -> sprites -> bg front half -> text
 *   (`screen_update`), sprites drawn from entry 127 down to 0 so entry 0 is
 *   on top (`draw_sprites`);
 * - bg pen 15 transparent in both halves (`set_transmask(.., 0x8000)`), text
 *   pen 3 transparent (`set_transparent_pen(3)`);
 * - the visible window = raster lines 16..239 of the 256-line tilemap/sprite
 *   space (MAME's classic `set_visible_area(0, 255, 16, 239)`), see
 *   {@link BLKTIGER_VISIBLE_Y0};
 * - the enable bits (port 0x0c bit 1 = bg off, bit 2 = sprites off; port 0x04
 *   bit 7 = text off), which MAME itself labels as guesses.
 * Flip screen (port 0x04 bit 6 in MAME) is not modelled.
 */

export const BLKTIGER_SCREEN_WIDTH = 256;
export const BLKTIGER_SCREEN_HEIGHT = 224;
/**
 * First visible raster line in the 256-line space tile scroll and sprite Y
 * live in. MAME prior art (`set_visible_area(0*8, 32*8-1, 2*8, 30*8-1)`),
 * not confirmed by the kolbold doc.
 */
export const BLKTIGER_VISIBLE_Y0 = 16;

export const BLKTIGER_BG_RAM_SIZE = 0x4000;
export const BLKTIGER_BG_BANK_SIZE = 0x1000;
export const BLKTIGER_TEXT_RAM_SIZE = 0x800;
export const BLKTIGER_SPRITE_RAM_SIZE = 0x200;
export const BLKTIGER_SPRITE_COUNT = 128;
/** Low plane (0xd800-0xdbff) at 0..0x3ff, high plane (0xdc00-0xdfff) at 0x400..0x7ff. */
export const BLKTIGER_PALETTE_RAM_SIZE = 0x800;
export const BLKTIGER_PALETTE_ENTRIES = 1024;

export const BLKTIGER_TILES_PALETTE_BASE = 0x000;
export const BLKTIGER_SPRITES_PALETTE_BASE = 0x200;
export const BLKTIGER_CHARS_PALETTE_BASE = 0x300;
export const BLKTIGER_BACKDROP_PEN = 0x3ff;

export const BLKTIGER_TILE_COUNT = 2048;
const TILE_PIXELS = 256;
const CHAR_PIXELS = 64;
const BG_TRANSPARENT_PEN = 15;
const SPRITE_TRANSPARENT_PEN = 15;
const TEXT_TRANSPARENT_PEN = 3;
/** bd01 output meaning "bg pixel behind sprites" (DS §5.5). */
const BD01_BEHIND = 0x9;

/** Decoded graphics, one pen index per pixel, row-major; tile `n` starts at `n * w * h`. */
export interface BlktigerGfx {
  /** 8x8 2bpp text glyphs (pens 0-3), 2048 x 64 bytes. */
  chars: Uint8Array;
  /** 16x16 4bpp background tiles (pens 0-15), 2048 x 256 bytes. */
  tiles: Uint8Array;
  /** 16x16 4bpp sprites (pens 0-15), 2048 x 256 bytes. */
  sprites: Uint8Array;
}

/** The two priority PROMs (256 bytes each, low nibble significant). */
export interface BlktigerProms {
  bd01: Uint8Array;
  bd02: Uint8Array;
}

/** Everything the video hardware reads in one frame. */
export interface BlktigerBoardState {
  /** 0x4000 bytes: the 4 bg tile RAM banks back to back. */
  bgRam: Uint8Array;
  /** 0x800 bytes: text codes 0x000-0x3ff, attrs 0x400-0x7ff (row-major 32x32). */
  textRam: Uint8Array;
  /** 0x200 bytes: the buffered sprite list the hardware draws (128 x code, attr, y, x). */
  spriteRam: Uint8Array;
  /** 0x800 bytes: palette low plane then high plane. */
  paletteRam: Uint8Array;
  /** 16-bit bg scroll X / Y. */
  scrollX: number;
  scrollY: number;
  /** Port 0x0e byte: non-zero = 8x4 pages (128x64 tiles), zero = 4x8 pages (64x128 tiles). */
  screenLayout: number;
  bgEnabled: boolean;
  spritesEnabled: boolean;
  textEnabled: boolean;
}

export interface BlktigerFrame {
  width: number;
  height: number;
  /** Palette-RAM index (0..1023) per pixel, row-major. */
  pixels: Uint16Array;
}

/** bg tile index (into `bgRam` tile words) for map cell (col,row); DS §8.1 scan formulas. Inputs wrap. */
export function blktigerBgTileIndex(col: number, row: number, screenLayout: number): number {
  if (screenLayout) {
    const c = col & 0x7f;
    const r = row & 0x3f;
    return (c & 0x0f) + ((r & 0x0f) << 4) + ((c & 0x70) << 4) + ((r & 0x30) << 7);
  }
  const c = col & 0x3f;
  const r = row & 0x7f;
  return (c & 0x0f) + ((r & 0x0f) << 4) + ((c & 0x30) << 4) + ((r & 0x70) << 6);
}

/** Map size in tiles for a layout byte: 128x64 (8x4) or 64x128 (4x8). */
export function blktigerBgMapSize(screenLayout: number): { cols: number; rows: number } {
  return screenLayout ? { cols: 128, rows: 64 } : { cols: 64, rows: 128 };
}

/**
 * 256-entry table, index `group*16 + pen`: 1 when that bg pixel is drawn in
 * front of sprites, per the bd02 -> bd01 PROM chain (DS §5.5). Pen 15 is
 * transparent and never drawn, whatever this says.
 */
export function blktigerBgFrontTable(proms: BlktigerProms): Uint8Array {
  if (proms.bd01.length < 256 || proms.bd02.length < 256) throw new Error('blktiger PROMs must be 256 bytes each');
  const out = new Uint8Array(256);
  for (let group = 0; group < 16; group++) {
    const p = proms.bd02[(group >> 1) << 5] & 3;
    for (let pen = 0; pen < 16; pen++) {
      out[group * 16 + pen] = (proms.bd01[0x40 | (p << 4) | pen] & 0xf) === BD01_BEHIND ? 0 : 1;
    }
  }
  return out;
}

/** One palette entry: `[r, g, b]` 8-bit, from the low/high plane bytes (DS §4, xBRG_444). */
export function decodeBlktigerPaletteEntry(lo: number, hi: number): [number, number, number] {
  const r = (lo >> 4) & 0xf;
  const g = lo & 0xf;
  const b = hi & 0xf;
  return [(r << 4) | r, (g << 4) | g, (b << 4) | b];
}

/** Palette RAM (0x800 bytes) -> 1024 x RGBA (alpha 255). */
export function blktigerPaletteToRgba(paletteRam: Uint8Array, out: Uint8Array = new Uint8Array(BLKTIGER_PALETTE_ENTRIES * 4)): Uint8Array {
  if (paletteRam.length < BLKTIGER_PALETTE_RAM_SIZE) throw new Error(`blktiger palette RAM must be ${BLKTIGER_PALETTE_RAM_SIZE} bytes`);
  for (let i = 0; i < BLKTIGER_PALETTE_ENTRIES; i++) {
    const [r, g, b] = decodeBlktigerPaletteEntry(paletteRam[i], paletteRam[0x400 + i]);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Indexed frame + RGBA palette -> RGBA pixels. */
export function blktigerFrameToRgba(frame: BlktigerFrame, paletteRgba: Uint8Array, out: Uint8Array = new Uint8Array(frame.width * frame.height * 4)): Uint8Array {
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

function checkGfx(gfx: BlktigerGfx): void {
  if (gfx.chars.length < BLKTIGER_TILE_COUNT * CHAR_PIXELS) throw new Error('blktiger chars must hold 2048 8x8 glyphs');
  if (gfx.tiles.length < BLKTIGER_TILE_COUNT * TILE_PIXELS) throw new Error('blktiger tiles must hold 2048 16x16 tiles');
  if (gfx.sprites.length < BLKTIGER_TILE_COUNT * TILE_PIXELS) throw new Error('blktiger sprites must hold 2048 16x16 tiles');
}

/**
 * Stateless renderer: board state -> indexed frame. Holds the decoded gfx and
 * the PROM-derived priority table so per-frame work is only the compositing.
 */
export class BlktigerRenderer {
  private readonly gfx: BlktigerGfx;
  private readonly front: Uint8Array;
  /** Scratch sprite layer: palette index per pixel, 0 = none (sprite indices are >= 0x200). */
  private readonly spriteLayer = new Uint16Array(BLKTIGER_SCREEN_WIDTH * BLKTIGER_SCREEN_HEIGHT);

  constructor(gfx: BlktigerGfx, proms: BlktigerProms) {
    checkGfx(gfx);
    this.gfx = gfx;
    this.front = blktigerBgFrontTable(proms);
  }

  render(state: BlktigerBoardState, out?: BlktigerFrame): BlktigerFrame {
    const W = BLKTIGER_SCREEN_WIDTH;
    const H = BLKTIGER_SCREEN_HEIGHT;
    const frame = out ?? { width: W, height: H, pixels: new Uint16Array(W * H) };
    if (frame.width !== W || frame.height !== H || frame.pixels.length < W * H) throw new Error('blktiger frame must be 256x224');
    const px = frame.pixels;
    const spr = this.spriteLayer;
    spr.fill(0);
    if (state.spritesEnabled) this.drawSprites(state.spriteRam, spr);

    const { tiles, chars } = this.gfx;
    const front = this.front;
    const bgOn = state.bgEnabled;
    const bg = state.bgRam;
    const layout = state.screenLayout;
    const { cols, rows } = blktigerBgMapSize(layout);
    const wMask = cols * 16 - 1;
    const hMask = rows * 16 - 1;
    const sx = state.scrollX & 0xffff;
    const sy = state.scrollY & 0xffff;

    for (let y = 0; y < H; y++) {
      const ty = (y + BLKTIGER_VISIBLE_Y0 + sy) & hMask;
      const row = ty >> 4;
      const tileY = (ty & 15) * 16;
      const o = y * W;
      for (let x = 0; x < W; x++) {
        let idx = BLKTIGER_BACKDROP_PEN;
        let bgFront = false;
        if (bgOn) {
          const tx = (x + sx) & wMask;
          const ti = blktigerBgTileIndex(tx >> 4, row, layout) * 2;
          const attr = bg[ti + 1];
          const code = bg[ti] | ((attr & 7) << 8);
          const fx = attr & 0x80 ? 15 - (tx & 15) : tx & 15;
          const pen = tiles[code * TILE_PIXELS + tileY + fx];
          if (pen !== BG_TRANSPARENT_PEN) {
            const gp = ((attr >> 3) & 0xf) * 16 + pen;
            idx = BLKTIGER_TILES_PALETTE_BASE + gp;
            bgFront = front[gp] === 1;
          }
        }
        if (!bgFront) {
          const s = spr[o + x];
          if (s) idx = s;
        }
        px[o + x] = idx;
      }
    }

    if (state.textEnabled) {
      const tr = state.textRam;
      for (let y = 0; y < H; y++) {
        const ry = y + BLKTIGER_VISIBLE_Y0;
        const rowBase = (ry >> 3) * 32;
        const glyphY = (ry & 7) * 8;
        const o = y * W;
        for (let x = 0; x < W; x++) {
          const ti = rowBase + (x >> 3);
          const attr = tr[ti + 0x400];
          const code = tr[ti] + ((attr & 0xe0) << 3);
          const pen = chars[code * CHAR_PIXELS + glyphY + (x & 7)];
          if (pen !== TEXT_TRANSPARENT_PEN) px[o + x] = BLKTIGER_CHARS_PALETTE_BASE + (attr & 0x1f) * 4 + pen;
        }
      }
    }
    return frame;
  }

  /** Entry 127 first, entry 0 last (on top); no wrap, clipped to the visible window. */
  private drawSprites(ram: Uint8Array, spr: Uint16Array): void {
    const W = BLKTIGER_SCREEN_WIDTH;
    const H = BLKTIGER_SCREEN_HEIGHT;
    const sprites = this.gfx.sprites;
    for (let n = BLKTIGER_SPRITE_COUNT - 1; n >= 0; n--) {
      const o = n * 4;
      const attr = ram[o + 1];
      const code = ram[o] | ((attr & 0xe0) << 3);
      const colorBase = BLKTIGER_SPRITES_PALETTE_BASE + (attr & 7) * 16;
      const flipX = (attr & 0x08) !== 0;
      const sx = ram[o + 3] - ((attr & 0x10) << 4);
      const sy = ram[o + 2] - BLKTIGER_VISIBLE_Y0;
      const base = code * TILE_PIXELS;
      for (let r = 0; r < 16; r++) {
        const y = sy + r;
        if (y < 0 || y >= H) continue;
        for (let c = 0; c < 16; c++) {
          const x = sx + c;
          if (x < 0 || x >= W) continue;
          const pen = sprites[base + r * 16 + (flipX ? 15 - c : c)];
          if (pen !== SPRITE_TRANSPARENT_PEN) spr[y * W + x] = colorBase + pen;
        }
      }
    }
  }
}

/**
 * The video side of the virtual board: the RAMs and registers game logic
 * writes, a sprite buffer latched at vblank, and the renderer.
 */
export class BlktigerVideo {
  readonly bgRam = new Uint8Array(BLKTIGER_BG_RAM_SIZE);
  readonly textRam = new Uint8Array(BLKTIGER_TEXT_RAM_SIZE);
  /** Live sprite RAM (Z80 0xfe00-0xffff) game logic writes. */
  readonly spriteRam = new Uint8Array(BLKTIGER_SPRITE_RAM_SIZE);
  /** The copy the hardware draws, taken by {@link vblank}. */
  readonly spriteBuffer = new Uint8Array(BLKTIGER_SPRITE_RAM_SIZE);
  readonly paletteRam = new Uint8Array(BLKTIGER_PALETTE_RAM_SIZE);
  scrollX = 0;
  scrollY = 0;
  screenLayout = 0;
  /** Port 0x0d: bg RAM bank 0-3 mapped at 0xc000. */
  bgBank = 0;
  bgEnabled = true;
  spritesEnabled = true;
  textEnabled = true;

  private readonly renderer: BlktigerRenderer;

  constructor(gfx: BlktigerGfx, proms: BlktigerProms) {
    this.renderer = new BlktigerRenderer(gfx, proms);
  }

  /** Z80 memory write into the video areas (0xc000-0xdfff, 0xfe00-0xffff); returns false for other addresses. */
  writeMemory(addr: number, value: number): boolean {
    const v = value & 0xff;
    if (addr >= 0xc000 && addr <= 0xcfff) this.bgRam[this.bgBank * BLKTIGER_BG_BANK_SIZE + (addr - 0xc000)] = v;
    else if (addr >= 0xd000 && addr <= 0xd7ff) this.textRam[addr - 0xd000] = v;
    else if (addr >= 0xd800 && addr <= 0xdfff) this.paletteRam[addr - 0xd800] = v;
    else if (addr >= 0xfe00 && addr <= 0xffff) this.spriteRam[addr - 0xfe00] = v;
    else return false;
    return true;
  }

  /**
   * Z80 `out` to a video port (DS §2 I/O map). Enable-bit meanings are MAME's
   * own guesses (`video_enable_w`, `video_control_w`); flip screen and the
   * non-video bits of port 0x04 are ignored. Returns false for other ports.
   */
  writePort(port: number, value: number): boolean {
    const v = value & 0xff;
    switch (port & 0xff) {
      case 0x04:
        this.textEnabled = (v & 0x80) === 0;
        return true;
      case 0x08:
        this.scrollX = (this.scrollX & 0xff00) | v;
        return true;
      case 0x09:
        this.scrollX = (this.scrollX & 0x00ff) | (v << 8);
        return true;
      case 0x0a:
        this.scrollY = (this.scrollY & 0xff00) | v;
        return true;
      case 0x0b:
        this.scrollY = (this.scrollY & 0x00ff) | (v << 8);
        return true;
      case 0x0c:
        this.bgEnabled = (v & 0x02) === 0;
        this.spritesEnabled = (v & 0x04) === 0;
        return true;
      case 0x0d:
        this.bgBank = v & 3;
        return true;
      case 0x0e:
        this.screenLayout = v;
        return true;
      default:
        return false;
    }
  }

  /** Latch the sprite list (MAME `buffered_spriteram8_device::vblank_copy_rising`): what is drawn next frame. */
  vblank(): void {
    this.spriteBuffer.set(this.spriteRam);
  }

  /** The state snapshot the renderer reads (shares the RAM buffers, no copies). */
  state(): BlktigerBoardState {
    return {
      bgRam: this.bgRam,
      textRam: this.textRam,
      spriteRam: this.spriteBuffer,
      paletteRam: this.paletteRam,
      scrollX: this.scrollX,
      scrollY: this.scrollY,
      screenLayout: this.screenLayout,
      bgEnabled: this.bgEnabled,
      spritesEnabled: this.spritesEnabled,
      textEnabled: this.textEnabled,
    };
  }

  render(out?: BlktigerFrame): BlktigerFrame {
    return this.renderer.render(this.state(), out);
  }

  paletteRgba(out?: Uint8Array): Uint8Array {
    return blktigerPaletteToRgba(this.paletteRam, out);
  }
}

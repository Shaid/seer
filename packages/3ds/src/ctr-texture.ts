/**
 * 3DS CTR texture decode → RGBA8, for the CT SDK pixel formats a CTPK can
 * carry (RGBA8 / RGB8 / RGBA5551 / RGB565 / RGBA4 / LA8 / HILO8 / L8 / A8 /
 * LA4 / L4 / A4 / ETC1 / ETC1A4).
 *
 * 3DS textures are stored as 8×8 tiles laid out in raster order; within a
 * tile the 64 pixels follow the classic CTR tile permutation. ETC1/ETC1A4
 * blocks are 4×4 pixels and use the 3DS block-order formula (8×8 super-blocks
 * of four 4×4 blocks).
 *
 * Reference: SciresM/FEAT's ctpktool (Texture.cs / ETC.cs) and CTR_Textures.cs.
 */
import { u32At } from './le.js';

/** Permutation: linear position k (0..63) within an 8×8 tile → (i, j). */
const TILE_ORDER = [
  0, 1, 8, 9, 2, 3, 10, 11, 16, 17, 24, 25, 18, 19, 26, 27, 4, 5, 12, 13, 6, 7, 14, 15, 20, 21, 28,
  29, 22, 23, 30, 31, 32, 33, 40, 41, 34, 35, 42, 43, 48, 49, 56, 57, 50, 51, 58, 59, 36, 37, 44,
  45, 38, 39, 46, 47, 52, 53, 60, 61, 54, 55, 62, 63,
];

const ETC_TABLE = [
  [2, 8, -2, -8],
  [5, 17, -5, -17],
  [9, 29, -9, -29],
  [13, 42, -13, -42],
  [18, 60, -18, -60],
  [24, 80, -24, -80],
  [33, 106, -33, -106],
  [47, 183, -47, -183],
] as const;

type FormatName =
  | 'rgba8'
  | 'rgb8'
  | 'rgba5551'
  | 'rgb565'
  | 'rgba4'
  | 'la8'
  | 'hilo8'
  | 'l8'
  | 'a8'
  | 'la4'
  | 'l4'
  | 'a4'
  | 'etc1'
  | 'etc1a4';

/** Map a CT SDK format id (see CTPK_TEXTURE_FORMATS) to a decodeable format. */
export function ctrFormatName(format: number): FormatName | undefined {
  const names: Record<number, FormatName> = {
    0: 'rgba8',
    1: 'rgb8',
    2: 'rgba5551',
    3: 'rgb565',
    4: 'rgba4',
    5: 'la8',
    6: 'hilo8',
    7: 'l8',
    8: 'a8',
    9: 'la4',
    10: 'l4',
    11: 'a4',
    12: 'etc1',
    13: 'etc1a4',
  };
  return names[format];
}

/**
 * Exact encoded byte size for a `width`×`height` texture in `format` — the
 * 3DS's 8×8-tiled formats always round up to a whole tile, so this can differ
 * from a naive `width*height*bpp`. Needed by container formats that give a
 * texture's raw GPU address but not its length (e.g. BCH, whose texture
 * table stores PICA200 command-buffer registers, not a byte count).
 */
export function ctrTextureByteSize(format: number, width: number, height: number): number {
  const name = ctrFormatName(format);
  if (!name) throw new Error(`Unsupported CTR texture format ${format}`);
  const tilesX = Math.ceil(width / 8);
  const tilesY = Math.ceil(height / 8);
  if (name === 'etc1' || name === 'etc1a4') {
    const blockSize = name === 'etc1a4' ? 16 : 8;
    return tilesX * tilesY * 4 * blockSize;
  }
  return tilesX * tilesY * 64 * bytesPerPixel(name);
}

/**
 * Decode CTR texture data into RGBA8 (`w*h*4` bytes). `format` is a CT SDK
 * format id (e.g. 12 = ETC1, 13 = ETC1A4); throws on an unsupported id.
 */
export function decodeCtrTexture(
  format: number,
  width: number,
  height: number,
  data: Uint8Array,
): Uint8Array {
  const name = ctrFormatName(format);
  if (!name) throw new Error(`Unsupported CTR texture format ${format}`);
  if (name === 'etc1' || name === 'etc1a4')
    return decodeEtc(data, width, height, name === 'etc1a4');
  return decodePlain(name, width, height, data);
}

function decodePlain(
  format: FormatName,
  width: number,
  height: number,
  data: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const tilesX = Math.ceil(width / 8);
  const tilesY = Math.ceil(height / 8);
  const bpp = bytesPerPixel(format);

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const tileBase = (ty * tilesX + tx) * 64 * bpp;
      for (let k = 0; k < 64; k++) {
        const i = TILE_ORDER[k] % 8;
        const j = (TILE_ORDER[k] - i) / 8;
        const px = tx * 8 + i;
        const py = ty * 8 + j;
        if (px >= width || py >= height) continue;
        const value = readPixelValue(format, data, tileBase, k, bpp);
        writePixel(format, out, value, py * width + px);
      }
    }
  }
  return out;
}

/** Bytes per pixel in the tile stream (0.5 for 4-bit formats). */
function bytesPerPixel(format: FormatName): number {
  switch (format) {
    case 'rgba8':
      return 4;
    case 'rgb8':
      return 3;
    case 'rgba5551':
    case 'rgb565':
    case 'rgba4':
    case 'la8':
    case 'hilo8':
      return 2;
    case 'l8':
    case 'a8':
    case 'la4':
      return 1;
    case 'l4':
    case 'a4':
      return 0.5;
    default:
      return 0;
  }
}

/** Read the raw bit-packed pixel value for linear pixel `k` within its tile. */
function readPixelValue(
  format: FormatName,
  data: Uint8Array,
  tileBase: number,
  k: number,
  bpp: number,
): number {
  const byteOff = tileBase + Math.floor(k * bpp);
  switch (format) {
    case 'rgba8':
      return u32At(data, byteOff);
    case 'rgb8':
      return data[byteOff] | (data[byteOff + 1] << 8) | (data[byteOff + 2] << 16);
    case 'rgba5551':
    case 'rgb565':
    case 'rgba4':
    case 'la8':
    case 'hilo8':
      return data[byteOff] | (data[byteOff + 1] << 8);
    case 'l8':
    case 'a8':
    case 'la4':
      return data[byteOff];
    case 'l4':
    case 'a4':
      // Two pixels per byte, low nibble first.
      return (data[byteOff] >> (k & 1 ? 4 : 0)) & 0xf;
    default:
      return 0;
  }
}

function writePixel(format: FormatName, out: Uint8Array, value: number, px: number): void {
  const o = px * 4;
  let r = 0xff;
  let g = 0xff;
  let b = 0xff;
  let a = 0xff;
  switch (format) {
    case 'rgba8':
      a = value & 0xff;
      b = (value >> 8) & 0xff;
      g = (value >> 16) & 0xff;
      r = (value >> 24) & 0xff;
      break;
    case 'rgb8':
      b = value & 0xff;
      g = (value >> 8) & 0xff;
      r = (value >> 16) & 0xff;
      break;
    case 'rgba5551':
      a = value & 1 ? 0xff : 0;
      r = ((value >> 11) & 0x1f) * 8;
      g = ((value >> 6) & 0x1f) * 8;
      b = ((value >> 1) & 0x1f) * 8;
      break;
    case 'rgb565':
      r = ((value >> 11) & 0x1f) * 8;
      g = ((value >> 5) & 0x3f) * 4;
      b = (value & 0x1f) * 8;
      break;
    case 'rgba4':
      a = (value & 0xf) * 16;
      r = ((value >> 12) & 0xf) * 16;
      g = ((value >> 8) & 0xf) * 16;
      b = ((value >> 4) & 0xf) * 16;
      break;
    case 'la8': {
      a = value & 0xff;
      const lum = (value >> 8) & 0xff;
      r = g = b = lum;
      break;
    }
    case 'hilo8':
      r = value & 0xff;
      g = (value >> 8) & 0xff;
      b = 0;
      break;
    case 'l8':
      r = g = b = value;
      break;
    case 'a8':
      a = value;
      r = g = b = 0;
      break;
    case 'la4': {
      a = (value & 0xf) * 16;
      const lum = ((value >> 4) & 0xf) * 16;
      r = g = b = lum;
      break;
    }
    case 'l4':
      r = g = b = value * 17;
      break;
    case 'a4':
      a = value * 17;
      r = g = b = 0;
      break;
  }
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
  out[o + 3] = a;
}

// ---------------------------------------------------------------------------
// ETC1 / ETC1A4
// ---------------------------------------------------------------------------

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function decodeEtc(data: Uint8Array, width: number, height: number, hasAlpha: boolean): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const blockSize = hasAlpha ? 16 : 8;

  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const off =
        (((x >> 3) + (y >> 3) * (width >> 3)) * 4 + ((x >> 2) & 1) + ((y >> 2) & 1) * 2) *
        blockSize;
      const a64 = hasAlpha ? readU64(data, off) : 0xffff_ffff_ffff_ffffn;
      const rgb64 = readU64(data, hasAlpha ? off + 8 : off);

      const flip = Number((rgb64 >> 32n) & 1n);
      const dif = Number((rgb64 >> 33n) & 1n);

      let r1: number;
      let g1: number;
      let b1: number;
      let r2: number;
      let g2: number;
      let b2: number;

      if (dif) {
        const mult = 0xff / 0x1f;
        const rt = signExtend3(Number((rgb64 >> 56n) & 7n));
        const gt = signExtend3(Number((rgb64 >> 48n) & 7n));
        const bt = signExtend3(Number((rgb64 >> 40n) & 7n));
        const r1b = Number((rgb64 >> 59n) & 31n);
        const g1b = Number((rgb64 >> 51n) & 31n);
        const b1b = Number((rgb64 >> 43n) & 31n);
        r1 = r1b * mult;
        g1 = g1b * mult;
        b1 = b1b * mult;
        r2 = clamp(r1b + rt) * mult;
        g2 = clamp(g1b + gt) * mult;
        b2 = clamp(b1b + bt) * mult;
      } else {
        const mult = 0xff / 0xf;
        r1 = Number((rgb64 >> 60n) & 15n) * mult;
        g1 = Number((rgb64 >> 52n) & 15n) * mult;
        b1 = Number((rgb64 >> 44n) & 15n) * mult;
        r2 = Number((rgb64 >> 56n) & 15n) * mult;
        g2 = Number((rgb64 >> 48n) & 15n) * mult;
        b2 = Number((rgb64 >> 40n) & 15n) * mult;
      }

      const cmpOne = Number((rgb64 >> 37n) & 7n);
      const cmpTwo = Number((rgb64 >> 34n) & 7n);

      // Byte-swapped 32-bit modulation word, as the reference reads it.
      const raw = Number(rgb64 & 0xffff_ffffn);
      const block =
        ((raw & 0xff000000) >>> 24) |
        ((raw & 0x00ff0000) >>> 8) |
        ((raw & 0x0000ff00) << 8) |
        ((raw & 0x000000ff) << 24);

      const putPixel = (
        px: number,
        py: number,
        r: number,
        g: number,
        b: number,
        bx: number,
        by: number,
        cmp: number,
      ) => {
        const o = (py * width + px) * 4;
        const shift = bx * 4 + by;
        const tm =
          shift < 8
            ? ((block >> (shift + 24)) & 1) + (((block << 1) >> (shift + 8)) & 2)
            : ((block >> (shift + 8)) & 1) + (((block << 1) >> (shift - 8)) & 2);
        const mod = ETC_TABLE[cmp][tm];
        const alpha = Number((a64 >> BigInt(shift * 4)) & 15n) * 16;
        out[o] = clamp(r + mod);
        out[o + 1] = clamp(g + mod);
        out[o + 2] = clamp(b + mod);
        out[o + 3] = alpha;
      };

      if (flip) {
        for (let by = 0; by < 2; by++) {
          for (let bx = 0; bx < 4; bx++) {
            putPixel(x + bx, y + by, r1, g1, b1, bx, by, cmpOne);
            putPixel(x + bx, y + by + 2, r2, g2, b2, bx, by + 2, cmpTwo);
          }
        }
      } else {
        for (let by = 0; by < 4; by++) {
          for (let bx = 0; bx < 2; bx++) {
            putPixel(x + bx, y + by, r1, g1, b1, bx, by, cmpOne);
            putPixel(x + bx + 2, y + by, r2, g2, b2, bx + 2, by, cmpTwo);
          }
        }
      }
    }
  }
  return out;
}

function readU64(data: Uint8Array, off: number): bigint {
  if (off < 0 || off + 8 > data.length) return 0n;
  return (
    BigInt(data[off]) |
    (BigInt(data[off + 1]) << 8n) |
    (BigInt(data[off + 2]) << 16n) |
    (BigInt(data[off + 3]) << 24n) |
    (BigInt(data[off + 4]) << 32n) |
    (BigInt(data[off + 5]) << 40n) |
    (BigInt(data[off + 6]) << 48n) |
    (BigInt(data[off + 7]) << 56n)
  );
}

/** Sign-extend a 3-bit two's-complement value to a signed range. */
function signExtend3(v: number): number {
  return v >= 4 ? v - 8 : v;
}

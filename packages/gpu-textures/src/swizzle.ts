/**
 * Tegra X1 (Nintendo Switch GPU) block-linear texture deswizzle.
 * Ported from the astral-extractor reference (which itself derives from
 * Ryujinx / aboood40091's BNTX-Extractor).
 */

export interface SwizzleFormatInfo {
  bpp: number;
  blockWidth: number;
  blockHeight: number;
  blockDepth: number;
}

export const SWIZZLE_FORMATS: Record<string, SwizzleFormatInfo> = {
  R8G8B8A8_UNORM: { bpp: 4, blockWidth: 1, blockHeight: 1, blockDepth: 1 },
  BC1_UNORM: { bpp: 8, blockWidth: 4, blockHeight: 4, blockDepth: 1 },
  BC2_UNORM: { bpp: 16, blockWidth: 4, blockHeight: 4, blockDepth: 1 },
  BC3_UNORM: { bpp: 16, blockWidth: 4, blockHeight: 4, blockDepth: 1 },
  BC4_UNORM: { bpp: 8, blockWidth: 4, blockHeight: 4, blockDepth: 1 },
  BC1_UNORM_SRGB: { bpp: 8, blockWidth: 4, blockHeight: 4, blockDepth: 1 },
  BC2_UNORM_SRGB: { bpp: 16, blockWidth: 4, blockHeight: 4, blockDepth: 1 },
  BC3_UNORM_SRGB: { bpp: 16, blockWidth: 4, blockHeight: 4, blockDepth: 1 },
  BC4_SNORM: { bpp: 8, blockWidth: 4, blockHeight: 4, blockDepth: 1 },
  BC6H_UF16: { bpp: 16, blockWidth: 4, blockHeight: 4, blockDepth: 1 },
  ASTC_4x4_UNORM: { bpp: 16, blockWidth: 4, blockHeight: 4, blockDepth: 1 },
  ASTC_8x8_UNORM: { bpp: 16, blockWidth: 8, blockHeight: 8, blockDepth: 1 },
  ASTC_4x4_SRGB: { bpp: 16, blockWidth: 4, blockHeight: 4, blockDepth: 1 },
  ASTC_8x8_SRGB: { bpp: 16, blockWidth: 8, blockHeight: 8, blockDepth: 1 },
};

function pow2RoundUp(x: number): number {
  x -= 1;
  x |= x >> 1;
  x |= x >> 2;
  x |= x >> 4;
  x |= x >> 8;
  x |= x >> 16;
  return x + 1;
}

function divRoundUp(n: number, d: number): number {
  return Math.floor((n + d - 1) / d);
}

function roundUp(x: number, y: number): number {
  return ((x - 1) | (y - 1)) + 1;
}

/**
 * Derive the Tegra X1 "optimal" block-height log2 for a mip-0 surface from
 * its block-count height alone, for formats that don't carry an explicit
 * block-height field (e.g. G1T, whose per-texture header has no room for
 * one). This is the standard Nvidia GOB-height selection rule also used by
 * BNTX-Extractor/Ryujinx: the block height (in GOBs, 8 rows each) grows to
 * the next power of two that covers the whole surface, capped at 16 GOBs
 * (blockHeightLog2 = 4).
 *
 * Confirmed against a real Three Hopes 128x128 BC1 icon (blockCountHeight =
 * 32): predicts log2 = 2, which is the only value (of 0-5 tried) that
 * decodes to a clean, uncorrupted image instead of scrambled/tiled output.
 */
export function computeBlockHeightLog2(blockCountHeight: number): number {
  const gobs = pow2RoundUp(divRoundUp(blockCountHeight, 8));
  return Math.round(Math.log2(Math.min(gobs, 16)));
}

/** Block-linear address computation (from the Tegra X1 TRM). */
function getAddrBlockLinear(
  x: number,
  y: number,
  imageWidthInBytes: number,
  bytesPerPixel: number,
  baseAddress: number,
  blockHeight: number,
): number {
  const imageWidthInGobs = divRoundUp(imageWidthInBytes, 64);
  const gobAddress =
    baseAddress +
    Math.floor(y / (8 * blockHeight)) * 512 * blockHeight * imageWidthInGobs +
    Math.floor((x * bytesPerPixel) / 64) * 512 * blockHeight +
    Math.floor((y % (8 * blockHeight)) / 8) * 512;

  x *= bytesPerPixel;
  return (
    gobAddress +
    Math.floor((x % 64) / 32) * 256 +
    Math.floor((y % 8) / 2) * 64 +
    Math.floor((x % 32) / 16) * 32 +
    (y % 2) * 16 +
    (x % 16)
  );
}

/**
 * Bidirectional block-linear swizzle/deswizzle. Exported (in addition to the
 * one-directional `deswizzle` below) so tests can round-trip a synthetic
 * linear buffer through `toSwizzle: true` then back through `deswizzle` to
 * verify block placement — see `tools/__tests__/g1t.test.ts`, which is the
 * regression test for the bpp/blkWidth mismatch bug this function's callers
 * used to have (byte-granular deswizzle of block-compressed data).
 */
export function swizzle(
  width: number,
  height: number,
  blkWidth: number,
  blkHeight: number,
  bpp: number,
  tileMode: number,
  blockHeightLog2: number,
  data: Uint8Array,
  toSwizzle: boolean,
): Uint8Array {
  const blockHeight = 1 << blockHeightLog2;
  const w = divRoundUp(width, blkWidth);
  const h = divRoundUp(height, blkHeight);

  let pitch: number;
  let surfSize: number;
  if (tileMode === 1) {
    pitch = roundUp(w * bpp, 32);
    surfSize = roundUp(pitch * h, 32);
  } else {
    pitch = roundUp(w * bpp, 64);
    surfSize = pitch * roundUp(h, blockHeight * 8);
  }

  const result = new Uint8Array(surfSize);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let pos: number;
      if (tileMode === 1) {
        pos = y * pitch + x * bpp;
      } else {
        pos = getAddrBlockLinear(x, y, w * bpp, bpp, 0, blockHeight);
      }
      const pos_ = (y * w + x) * bpp;
      if (pos + bpp <= surfSize) {
        if (toSwizzle) {
          for (let k = 0; k < bpp; k++) result[pos + k] = data[pos_ + k];
        } else {
          for (let k = 0; k < bpp; k++) result[pos_ + k] = data[pos + k];
        }
      }
    }
  }
  return result.slice(0, w * h * bpp);
}

/**
 * Total (GOB-padded) byte size of a `tileMode=0` block-linear surface for a
 * given `blockHeightLog2` — the span `swizzle()`/`deswizzle()` actually
 * address into via `getAddrBlockLinear()`. This routinely **exceeds** the
 * format's own "tight" `ceil(w/blkW)*ceil(h/blkH)*bpp` block-data size
 * whenever the surface's block-count width or height isn't already an exact
 * multiple of the GOB unit (64 bytes per GOB-row, `blockHeight*8` block-rows
 * per GOB-column) — e.g. 1080x1920 BC1 (Three Hopes still-art, see
 * `docs/few-threehopes.md`'s "Still-art garbling" section): tight
 * 1,036,800 B vs. padded 1,114,112 B, a 77,312 B shortfall.
 *
 * A caller that slices its input buffer to just the tight size before
 * calling `deswizzle()` silently starves every GOB-column/row past the tight
 * boundary — `data[pos+k]` for `pos >= data.length` reads `undefined`,
 * which Uint8Array assignment coerces to 0, producing a corrupted (not
 * thrown) decode. Callers of `deswizzle()` for Morton/block-linear textures
 * should slice up to `min(swizzledSurfaceSize(...), bytesAvailableInFile)`,
 * not the tight block size, so any real padding bytes the container does
 * carry get read.
 */
export function swizzledSurfaceSize(width: number, height: number, blkWidth: number, blkHeight: number, bpp: number, blockHeightLog2: number): number {
  const w = divRoundUp(width, blkWidth);
  const h = divRoundUp(height, blkHeight);
  const blockHeight = 1 << blockHeightLog2;
  const pitch = roundUp(w * bpp, 64);
  return pitch * roundUp(h, blockHeight * 8);
}

/** Deswizzle texture data (toSwizzle = false). */
export function deswizzle(
  width: number,
  height: number,
  _depth: number,
  blkWidth: number,
  blkHeight: number,
  _blkDepth: number,
  bpp: number,
  tileMode: number,
  blockHeightLog2: number,
  data: Uint8Array,
): Uint8Array {
  return swizzle(width, height, blkWidth, blkHeight, bpp, tileMode, blockHeightLog2, data, false);
}

/**
 * Decode a texture's data into linear, block-linear order (per-mip).
 * Returns the (possibly deswizzled) block data for the given mip level.
 */
export function getImageData(
  format: string,
  width: number,
  height: number,
  depth: number,
  _mipCount: number,
  blockHeightLog2: number,
  data: Uint8Array,
  mipLevel = 0,
  linearTileMode = false,
): Uint8Array {
  const info = SWIZZLE_FORMATS[format];
  if (!info) throw new Error(`Unknown swizzle format ${format}`);
  const bpp = info.bpp, blkWidth = info.blockWidth, blkHeight = info.blockHeight, blkDepth = info.blockDepth;

  const mipW = Math.max(1, width >> mipLevel);
  const mipH = Math.max(1, height >> mipLevel);
  const linesPerBlockHeight = (1 << blockHeightLog2) * 8;
  let blockHeightShift = 0;
  if (pow2RoundUp(divRoundUp(mipH, blkHeight)) < linesPerBlockHeight) {
    blockHeightShift += 1;
  }

  const tileMode = linearTileMode ? 1 : 0;
  const shifted = Math.max(0, blockHeightLog2 - blockHeightShift);
  return deswizzle(mipW, mipH, depth, blkWidth, blkHeight, blkDepth, bpp, tileMode, shifted, data);
}

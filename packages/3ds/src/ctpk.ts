/**
 * CTPK texture-pack container parser (CT SDK "texture pack" format used by
 * Fire Emblem Awakening/Fates for backgrounds, unit-map sprites and portrait
 * parts). Layout reference: SciresM/FEAT's ctpktool.
 *
 * A CTPK is `[0x20-byte header][entry table][filenames][hashes][info][data]`:
 *
 *   0x00  "CTPK"
 *   0x04  version (u16), texture count (u16)
 *   0x08  texture section offset (u32), size (u32)
 *   0x10  hash section offset (u32), texture-info section offset (u32)
 *   ...   0x20-byte entry per texture (offset 0x20 * (i+1))
 *   ...   null-terminated filenames (Shift-JIS)
 *   ...   hash entries (u32 hash + u32 index per texture)
 *   ...   texture-info u32s
 *   ...   padded to 0x80, then raw texture data
 *
 * Texture pixel formats use the CT SDK `GPU_FORMAT_*` numbering — NOT the
 * 3DS hardware enums — so 12 = ETC1 and 13 = ETC1A4.
 */
import { u32At, u16At } from './le.js';
import { CTR_FORMAT_NAMES } from './ctr-texture.js';

/**
 * CT SDK pixel-format ids. Re-exported from `ctr-texture.ts` (the decoder
 * that has to agree with it) rather than kept as a second, value-identical
 * copy here.
 */
export const CTPK_TEXTURE_FORMATS: Readonly<Record<number, string>> = CTR_FORMAT_NAMES;

export interface CtpkTexture {
  name: string;
  /** CT SDK pixel format id (see CTPK_TEXTURE_FORMATS). */
  format: number;
  width: number;
  height: number;
  mipLevel: number;
  type: number;
  /** Offset of the texture data from the start of the texture section. */
  dataOffset: number;
  dataSize: number;
}

export interface Ctpk {
  version: number;
  textureSectionOffset: number;
  textureSectionSize: number;
  textures: CtpkTexture[];
}

function readCString(data: Uint8Array, off: number): string {
  let end = off;
  while (end < data.length && data[end] !== 0) end++;
  // Filenames are Shift-JIS; decode byte-wise (lossy for non-ASCII but
  // keeps ASCII paths exact) — enough for asset naming and dedupe.
  return new TextDecoder('shift_jis').decode(data.subarray(off, end));
}

/** Parse a CTPK buffer. Throws on a bad magic. */
export function parseCtpk(data: Uint8Array): Ctpk {
  if (u32At(data, 0) !== 0x4b505443) throw new Error('Not a CTPK file');
  const version = u16At(data, 4);
  const count = u16At(data, 6);
  const textureSectionOffset = u32At(data, 8);
  const textureSectionSize = u32At(data, 12);

  const textures: CtpkTexture[] = [];
  for (let i = 0; i < count; i++) {
    const base = 0x20 * (i + 1);
    const pathOff = u32At(data, base);
    textures.push({
      name: readCString(data, pathOff),
      format: u32At(data, base + 12),
      width: u16At(data, base + 16),
      height: u16At(data, base + 18),
      mipLevel: data[base + 20],
      type: data[base + 21],
      dataOffset: u32At(data, base + 8),
      dataSize: u32At(data, base + 4),
    });
  }

  return { version, textureSectionOffset, textureSectionSize, textures };
}

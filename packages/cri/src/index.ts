/**
 * Barrel re-export for @seer-project/cri.
 *
 * CRI Middleware format readers: the CPK archive container plus its shared
 * `@UTF`-table engine and CRILAYLA decompressor (`cpk.ts`), the ADX 4-bit
 * ADPCM audio codec (`adx.ts`), the AWB (Atom Wave Bank) sound-bank
 * container (`awb.ts`), and the ACB (Atom Cue Bank) reader that ties cue
 * names to AWB byte ranges (`acb.ts`). All four are browser-safe (no
 * `Buffer`/`node:` usage) — pure `Uint8Array`/`DataView` in, `Uint8Array`/
 * plain data out.
 *
 * Audio payload decoding is out of scope beyond ADX itself: ACB/AWB report
 * structural metadata (codec name, sample rate, channel count, byte
 * ranges) for HCA/ATRAC3 streams without decoding them.
 */
export * from './cpk.js';
export * from './adx.js';
export * from './awb.js';
export * from './acb.js';

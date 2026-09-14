/**
 * Barrel re-export for @seer-project/dos.
 *
 * DOS executable-compression decoders: Microsoft's EXEPACK (`exepack.ts`)
 * and Okumura's LZHUF codec (`lzhuf.ts`). Both are browser-safe (no
 * `Buffer`/`node:` usage) — pure `Uint8Array` in, `Uint8Array` out.
 *
 * Archive/container formats built on top of LZHUF (e.g. a game's own
 * `.HUF` directory framing) are game-specific and stay in the consuming
 * project; only the codec itself lives here.
 */
export * from './exepack.js';
export * from './lzhuf.js';

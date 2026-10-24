/**
 * Nintendo 3DS asset-format primitives: CTPK texture packs, the CT SDK CTR
 * texture tile/ETC1 decoder, the Nintendo LZ10/LZ11/LZ13 decompressors,
 * BCSTM/BFSTM streamed-audio headers, and the BCH/CGFX 3D model containers.
 *
 * This barrel is browser-safe (no `node:*` imports). For 3DS game-container
 * access (NCSD/NCCH/CIA → RomFS, and NCCH AES key derivation — both
 * genuinely Node-only, needing `node:fs`/`node:crypto`), import from
 * `@seer-project/3ds/node` instead.
 */
export * from './le.js';
export * from './ctpk.js';
export * from './lz.js';
export * from './ctr-texture.js';
export * from './bcstm.js';
export * from './mat4-ctr.js';
export * from './ctr-anim.js';
export * from './bch.js';
export * from './cgfx.js';

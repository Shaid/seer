/**
 * Node-only 3DS game-container access -- NCSD (.3ds) / NCCH (.cxi) / CIA
 * (.cia) -> RomFS discovery and walking (`node/container.js`), plus NCCH AES
 * key derivation and AES-CBC/CTR decryption for sealed CIA content
 * (`node/crypto.js`). Kept out of the main browser-safe barrel (`./index.js`)
 * since both import `node:fs`/`node:crypto`.
 */
export * from './node/container.js';
export * from './node/crypto.js';

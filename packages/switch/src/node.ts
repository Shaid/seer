/**
 * Node-only Switch container access — reading a PFS0/NSP's entry table off
 * disk without loading the file, and carving a byte range out of it.
 * Kept out of the browser-safe barrel (`./index.js`) because it imports
 * `node:fs`.
 */
export * from './node/container.js';

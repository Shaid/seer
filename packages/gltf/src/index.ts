/**
 * A byte-level glTF 2.0 / GLB read+write pipeline for extraction tools:
 * builder helpers (buffer/accessor bookkeeping, skeleton matrix math, GLB
 * packing), a reader (accessors, nodes, skins, primitives), and a
 * geometry-only weapon-shape mesh classifier.
 *
 * This barrel is browser-safe (no Node imports). For decoding an embedded
 * PNG's pixels (`readImage`, `readBaseColorImage`, which need `pngjs`),
 * import from `@seer-project/gltf/node` instead.
 */
export * from './builder.js';
export * from './reader.js';
export * from './mesh-shape-classifier.js';

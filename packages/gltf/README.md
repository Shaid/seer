# @seer-project/gltf

A byte-level glTF 2.0 / GLB read+write pipeline for extraction tools:

- **`builder.ts`** — GLB assembly: buffer/accessor bookkeeping, 4x4 matrix
  math for skeleton world transforms (Euler/quaternion <-> matrix, inverse,
  multiply), embedded-PNG textures, animation channels, and final binary
  packing (`assembleGLB`).
- **`reader.ts`** — the read direction: the two-chunk GLB container
  (`parseGLB`), accessors (including `normalized` denormalization and
  interleaved `byteStride`), node TRS (`matrix` decomposed when present),
  skins, and primitives.
- **`mesh-shape-classifier.ts`** — a geometry-only "is this prop weapon-
  shaped" heuristic that reads nothing but a built GLB's own POSITION
  accessors, so it works against any project's prop corpus. **Its default
  thresholds are calibrated against one game's art style and scale — see the
  file's doc comment before assuming they transfer to yours.**

This is a narrower scope than the full glTF 2.0 spec — just what a skinned-
mesh exporter/importer needs. No sparse-accessor support, and only the
`TRIANGLES` primitive mode (the only one `builder.ts` ever emits).

## Two import paths

The default entry point (`@seer-project/gltf`) is **browser-safe** — no
`node:*` imports, no `Buffer` — so it works in a bundled viewer as well as
offline pipeline code. Decoding an embedded PNG's actual pixels needs
`pngjs`, and lives in the `./node` subpath:

```ts
import { newBuilder, assembleGLB, parseGLB, readAccessor } from '@seer-project/gltf';
import { readImage, readBaseColorImage } from '@seer-project/gltf/node';
```

`reader.ts`'s `baseColorImageSource` (browser-safe) resolves a material's
base-color texture down to an image index; `readImage`/`readBaseColorImage`
(Node-only) decode that image's actual pixels.

## What's deliberately not here

- A three.js scene loader for a live viewer (`@seer-project/engine-3d`'s
  `gltf.ts` covers that — a different concern from this package's byte-level
  read/write of `.glb` files for extraction tooling).
- `uri`-referenced external images beyond what `GlbFile.resolveUri` can
  resolve, and JPEG images — every writer in this ecosystem embeds PNGs via
  `bufferView`, so that's the only image path exercised.

## Testing

```bash
npm test
npm run lint
```

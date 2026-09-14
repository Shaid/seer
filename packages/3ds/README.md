# @seer-project/3ds

Nintendo 3DS asset-format primitives:

- **`ctpk.ts`** — the CT SDK CTPK texture-pack container (backgrounds,
  unit-map sprites, portrait parts).
- **`lz.ts`** — the Nintendo LZ10/LZ11 decompressors, plus the "LZ13"
  4-byte-wrapped-LZ11 variant some 3DS titles ship.
- **`ctr-texture.ts`** — CTR (3DS GPU) texture tile/ETC1 decode to RGBA8, for
  the CT SDK pixel formats a CTPK entry (or a BCH/CGFX texture) can carry.
- **`bcstm.ts`** — BCSTM/BFSTM streamed-audio header parsing (codec, sample
  rate, channel count, loop points). Sample-data decode is out of scope —
  shell out to ffmpeg's own `bfstm` demuxer, or decode DSP-ADPCM/IMA-ADPCM/PCM
  yourself.
- **`bch.ts`** — the raw 3DS BCH model container (PICA200 GPU command
  buffers, vertex/index buffers, skeletons, skeletal animation clips).
- **`cgfx.ts`** — the CGFX resource container (CMDL models, TXOB textures,
  materials, CANM skeletal animation clips) used by several 3DS titles'
  in-house engines.
- **`mat4-ctr.ts`** — the row-major 4×4 matrix helpers `bch.ts` and `cgfx.ts`
  both need for rigid-skinning bind-pose transforms and Euler→quaternion
  conversion (see below).
- **`node/container.ts`** — 3DS game container access: NCSD (`.3ds`) / NCCH
  (`.cxi`) / CIA (`.cia`) → RomFS discovery and directory-tree walking.
- **`node/crypto.ts`** — NCCH AES key derivation (Citra `aes_keys.txt` key
  slots, ticket parsing, common-key-Y/seed key scrambling) and AES-CBC/CTR
  decryption, for unpacking a sealed CIA's ExeFS/RomFS.

Install only if your target is a Nintendo 3DS title.

## Two import paths

The default entry point (`@seer-project/3ds`) is **browser-safe** — no
`node:*` imports — so it works in a browser asset viewer as well as offline
pipeline code. 3DS game-container access (opening a real `.3ds`/`.cxi`/`.cia`
off disk, and the AES key derivation/decryption a sealed CIA needs) lives in
the `./node` subpath:

```ts
import { parseCtpk, parseBch, parseCgfx, decodeCtrTexture } from '@seer-project/3ds';
import { openContainer, walkRomfs, parseAesKeys } from '@seer-project/3ds/node';
```

## Why `mat4-ctr.ts` is its own file

`bch.ts` and `cgfx.ts` are independent ports of two different 3DS model
containers (Ohana3DS-Rebirth's `Models/BCH.cs` and `Models/CGFX.cs`
respectively), but they need the same row-major 4×4 matrix math for
rigid-skinning bind-pose transforms and Euler→quaternion conversion. Rather
than duplicate `matMul`/`matApply`/`matIdentity`/`matScale`/`matRotX`/
`matRotY`/`matRotZ`/`matTranslate`/`matToQuaternion`/`eulerToQuaternion`/
`mat4Invert` in both files (which is how they existed before this package —
byte-identical copies, confirmed at extraction time — and which would also
collide on `eulerToQuaternion`/`mat4Invert` in this package's flat barrel),
both files import them from `mat4-ctr.ts`, which is the single place the
package barrel exports them from.

`accumulateBone` (a bone's accumulated bind-pose transform) is deliberately
**not** shared: `bch.ts`'s and `cgfx.ts`'s versions take differently-shaped
bone-array types and, as of this package's extraction, have diverged in
behavior — `bch.ts`'s guards against an undefined bone entry and an
out-of-range or self-referential parent index; `cgfx.ts`'s doesn't. Each file
keeps its own copy rather than being forced onto a shared implementation that
would either silently add or silently drop that safety check on one side.

For the same reason, `bch.ts`'s `sampleBchSkeletalAnimation` and `cgfx.ts`'s
`sampleCgfxSkeletalAnimation` are two separate, differently-named functions
(each was originally called `sampleSkeletalAnimation` in its own file, which
would have collided in this package's barrel) — they resample structurally
similar but independently-parsed animation-track shapes (`BchSkeletalAnimation`
vs. `CgfxSkeletalAnimation`), not a single shared type.

## What's deliberately not here

Game-specific formats built on top of these primitives — a title's own
archive/container format, its per-game CIA decryption wrapper, or its own
engine's model/texture formats (MT Framework, G1M/G1T, etc.) — stay in the
consuming project rather than shipping in this package.

## Testing

```bash
npm test
npm run lint
```

The NCCH key-derivation tests in `src/node/__tests__/crypto.test.ts` that
need real console key material (a real ticket's encrypted title key, a real
seed) are gated behind an optional, gitignored fixture and always skip in
this package (no game data ships here) — everything else runs
unconditionally, with no ROM/CIA present.

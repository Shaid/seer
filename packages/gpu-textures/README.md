# @seer-project/gpu-textures

GPU texture codecs used by modern console decompilation:

- **`swizzle.ts`** — Tegra X1 (Nintendo Switch) block-linear (de)swizzle:
  GOB address computation, `swizzle`/`deswizzle` (bidirectional, so tests can
  round-trip), `computeBlockHeightLog2` (derives the GOB block-height for a
  mip-0 surface when the container has no explicit field for it), and
  `swizzledSurfaceSize` (the real GOB-padded byte span a caller must slice
  up to — see its doc comment for a confirmed real-corpus example where the
  format's own "tight" block-data size undershoots by 77 KB).
- **`bc.ts`** — BC1-7/S3TC block compression: `decodeBC1`-`decodeBC5`, a
  full spec-conformant `decodeBC7` (ported from Microsoft's DirectXTex
  reference decoder, MIT), an approximate `decodeBC6H` (grayscale — exact
  BC6H decoding isn't implemented), and simple bounding-box `encodeBC1`/
  `encodeBC3` encoders (adequate quality for round-tripping a modded
  texture, not a maximum-quality encoder).
- **`astc.ts`** — ASTC decode via `@tootallnate/astc-wasm` (MIT), with
  band-decoding so a large surface doesn't overflow the WASM decoder's
  fixed memory arena.
- **`zstd.ts`** — one-shot Zstandard decompression via
  `@tootallnate/zstd-wasm` (MIT).

## A known, deliberately-not-fixed decoder bug

`decodeBC2`/`decodeBC3`'s shared alpha-index unpacking (`decodeBC23`) has a
pre-existing bug: it builds a 48-bit index field with `aBits |= data[b+2+i]
<< (i*8)` for `i` up to 5, and JS's `<<` masks its shift count to 5 bits, so
`i=4`/`i=5` (shifts 32 and 40) silently wrap to shifts 0 and 8 instead —
corrupting roughly the last 5 texels' alpha index per block. This is a
correctness bug in real, already-shipped extraction output for every game
using BC2/BC3 textures through this decoder, carried forward unfixed
because fixing it is a behavior change to an already-shipped asset corpus
that needs its own dedicated regression pass, not something to fold into an
unrelated package extraction. See `bc.ts`'s `encodeBC3AlphaBlock` doc
comment for the full detail — that function writes spec-correct bytes
despite this, since real Switch hardware (not this decoder) is the actual
consumer of an encoded/modded texture.

`decodeBC6H` is also approximate (unpacked to grayscale luminance, not a
real BC6H decode) — flagged the same way `decodeBC7` used to be before it
was replaced with a full conformant decoder; BC6H hasn't had that pass yet.

## Provenance

`swizzle.ts`'s block-linear algorithm is ported from the astral-extractor
reference implementation, which itself derives from Ryujinx and
aboood40091's BNTX-Extractor — see
[`THIRD-PARTY-LICENSES.md`](../../THIRD-PARTY-LICENSES.md) for the
licensing note on that chain. `bc.ts`'s BC7 mode tables and decoder are
ported field-for-field from Microsoft's DirectXTex (MIT) — there is nothing
game-specific about BC7, a public Khronos/Microsoft format, so porting the
spec's own reference decoder is the correct approach rather than reverse-
engineering it from any one game's executable.

## Testing

```bash
npm test
npm run lint
```

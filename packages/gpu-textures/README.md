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

## Fixed 2026-10-25: the 48-bit index-field shift bug

`decodeBC3`, `decodeBC4` and `decodeBC5` each used to build their 48-bit
3-bit-index field with `bits |= data[b+2+i] << (i*8)` for `i` up to 5. JS's
`<<` coerces to int32 and masks its shift count to 5 bits, so `i=4`/`i=5`
(shifts 32 and 40) silently wrapped to shifts 0 and 8 — OR'ing the top two
bytes back over the bottom two. The damage was *not* confined to the high
texels: a hand-built BC4 block with indices `0..7,0..7` decoded with texels
0, 2, 3, 4, 10, 11 and 14 all wrong.

All four decode sites now share `unpackIndices3`, which splits the field at
its natural midpoint — texels 0-7 are exactly bytes 0-2 and texels 8-15 are
exactly bytes 3-5, so no index straddles the halves and no shift exceeds 31
(no BigInt in the hot loop). `decodeBC2` was never affected: it reads 4-bit
alpha nibbles directly and ignores the index field entirely.

**This changes decoded bytes.** Any PNG/atlas previously extracted from a
BC3/BC4/BC5 source through this decoder is wrong and should be regenerated.
`encodeBC3AlphaBlock` always wrote spec-correct bytes, so encoded output is
unaffected.

## Fixed 2026-10-25: BC2/BC3 took BC1's punch-through colour branch

BC1 gives the endpoint ordering a meaning: `c0 <= c1` selects a 3-opaque-colour
palette whose fourth entry is transparent black, instead of the usual four
interpolated opaque colours. BC2 and BC3 carry alpha in their own 8-byte
sub-block, so for them the ordering is meaningless and the colour block is
*unconditionally* 4-colour (D3D BC2/BC3 spec; DirectXTex decodes both with its
colour-key flag off).

`decodeBC23` passed BC1's punch-through flag straight through, so every BC2 or
BC3 block whose 565 endpoints happened to land in `c0 <= c1` order decoded
palette entry 2 as the ½-average of the endpoints instead of the 2/3 point, and
palette entry 3 as black instead of the 1/3 point (the stray alpha the
punch-through entry carries was already being discarded, so only RGB moved).
Roughly half of all blocks fall in that ordering, and the texels affected are
the ones using indices 2 and 3 — so the artefact is washed-out midtones plus
black speckle, not a uniform shift.

**This changes decoded bytes** for BC2 and BC3 (only); BC1 is unchanged and
still honours punch-through. Anything extracted from a BC2/BC3 source through
this decoder should be regenerated. Encoding is unaffected: `encodeBC1Block`
always forces `c0 > c1`, which BC1 needs and BC3 is indifferent to.

`decodeBC6H` is approximate (unpacked to grayscale luminance, not a
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

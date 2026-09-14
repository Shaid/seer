# @seer-project/gfx

Retro bitmap pixel-format decoders and a generic scanline/line rasteriser —
started as the Amiga/Atari-ST planar slice, now also DOS CGA/Tandy
packed-pixel, Sega Genesis/Mega Drive VDP tiles, and polygon fill/line
drawing.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Optional — install only if your target game stores planar graphics. One
layout-parameterised decoder replaces the per-game `decodePlanar` copies
that used to live in each consuming repo (see
`docs/common-tooling-candidates.md` §1 in the seer workspace). Browser-safe,
zero dependencies.

## Installation

```bash
npm install @seer-project/gfx
```

## Usage

```ts
import {
  decodePlanar,
  expandPalette,
  greyscaleRamp,
  indicesToRGBA,
} from '@seer-project/gfx';

// 320×200, 5 bitplanes, ILBM-style row-interleaved layout.
const indices = decodePlanar(data, {
  width: 320,
  height: 200,
  planes: 5,
  layout: 'row-interleaved',
});

// Render greyscale until the real palette is independently confirmed.
const rgba = indicesToRGBA(indices, greyscaleRamp(5));

// Once confirmed: expand the game's own colour words.
const palette = expandPalette(colorWords, 'amiga12'); // or 'amiga24' for AGA
const colored = indicesToRGBA(indices, palette, { transparentIndex: null });
```

### Layouts

| `layout` | Storage order | Typical source |
|---|---|---|
| `plane-major` | whole planes back-to-back | Black Crypt, masked sprite banks |
| `row-interleaved` | each row stores all its planes | ILBM `BODY`, most screen dumps |
| `word-interleaved` | planes alternate every word within a row | Atari ST native, ST-derived containers |

`offset`, `rowBytes` (row padding), `planeStride` (plane-major plane
padding) and `interleave` cover the padded variants. Decoding never throws
on short input — bytes past the end read as zero, which is deliberate:
probing an unknown offset should degrade, not abort.

### Transparency is opt-in

`indicesToRGBA` renders fully opaque unless you pass an explicit
`transparentIndex` (or a `mask` plane). Index 0 is a real, opaque colour in
many of these games — transparency is never assumed.

### DOS CGA/Tandy packed-pixel

`decodePackedPixelLinear`/`decodeCgaBanked` decode chunky (non-planar) N
bits/pixel formats, pixels packed MSB-first within each byte — DOS CGA
(2bpp) and Tandy 16-colour (4bpp) graphics. `decodeCgaBanked` additionally
un-interleaves the classic IBM CGA hardware video-memory bank layout (even
scanlines at the base offset, odd scanlines `bankGap` bytes later).
`indicesToRGBAWithTransparency` renders the result against a `{r,g,b}[]`
palette with a caller-chosen transparent index (these formats commonly key
transparency off the max index rather than 0):

```ts
import { decodePackedPixelLinear, indicesToRGBAWithTransparency } from '@seer-project/gfx';

const indices = decodePackedPixelLinear(data, offset, 320, 200, 4); // Tandy 4bpp
const rgba = indicesToRGBAWithTransparency(indices, palette, 15);
```

### Scanline polygon fill + Bresenham lines

`scanlineFillPolygon`/`bresenhamLine` are a generic even-odd scanline fill
and Bresenham line rasteriser, parameterised over a `plot(x, y)` callback
so they can draw into any pixel buffer shape (palette-index bytes, RGB,
RGBA, a canvas API) without this package knowing the format. Both clip to
`[0, width) x [0, height)` internally:

```ts
import { scanlineFillPolygon, bresenhamLine } from '@seer-project/gfx';

const indices = new Uint8Array(w * h);
scanlineFillPolygon(points, w, h, (x, y) => { indices[y * w + x] = color; });
bresenhamLine(x0, y0, x1, y1, w, h, (x, y) => { indices[y * w + x] = color; });
```

### Sega Genesis/Mega Drive VDP

`decodeTile4bpp`/`decodeTileBank` decode the standard Genesis "linear 4bpp"
8×8 tile format (two pixels/byte, high nibble first). `cramWordToRGB`/
`readCramPalette` decode VDP CRAM colour words (`0000 BBB0 GGG0 RRR0`);
`isValidCramWord`/`isCramPaletteAt` probe whether a candidate ROM offset
holds structurally valid CRAM data (every unused/padding bit zero) —
useful for locating a palette table by scanning:

```ts
import { decodeTileBank, readCramPalette } from '@seer-project/gfx';

const { tileCount, indices } = decodeTileBank(tileData);
const palette = readCramPalette(rom, cramOffset); // flat [r,g,b,...] triples
```

### VGA 6-bit-per-channel palettes

`expandVga6` expands one VGA DAC channel value (0-63) to 8-bit (0-255) —
DOS VGA's `Set Block of DAC Color Registers` convention, which stores each
channel as its own byte rather than one packed word like `expandColorWord`
consumes:

```ts
import { expandVga6 } from '@seer-project/gfx';

const g8 = expandVga6(vga6Palette[i][1]); // one 6-bit green channel -> 8-bit
```

## License

AGPL-3.0-or-later

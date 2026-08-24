# @seer-project/gfx

Retro bitmap pixel-format decoders — currently the Amiga/Atari-ST planar
slice.

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

## License

AGPL-3.0-or-later

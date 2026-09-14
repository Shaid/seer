# @seer-project/playstation

PlayStation-family (PSX/PS2/PSP) hardware and disc-format primitives:

- **`cd/sector.ts`** — raw CD sector layout (2352-byte MODE1/MODE2), CD-XA
  subheaders, BCD/MSF/LBA math, and `RawCdReader`/`PlainSectorReader`
  (browser-safe, take a `readBytes` callback rather than opening a file).
- **`cd/iso9660.ts`** — a directory-record walker parameterized over a
  `DiscReader`, so the same code reads a raw MODE2/2352 CD image or a plain
  2048-byte-stride image (a PSP UMD, or a cooked/stripped ISO) alike.
- **`cd/cue-sheet.ts`** — `.cue`/`.bin` sheet parsing, per-track byte-range
  math, and raw-audio-sector decoding.
- **`psx/tim.ts`** — the standard PSY-Q SDK "TIM" texture container.
- **`psx/str-xa.ts`** — "STR" MDEC video + CD-XA ADPCM audio container
  parsing and CD-XA rewrapping (for a standard decoder like ffmpeg).
- **`psx/lzs.ts`** — the classic PSX LZSS/"ALZ1" variant.
- **`psx/spu-reverb.ts`** — the PlayStation SPU's hardware reverb DSP and its
  10 standard libspu presets.
- **`psp/atrac3p.ts`** — PSP PSMF ATRAC3+ elementary-stream extraction and a
  minimal Sony OMA/"EA3" container writer.

Install only if your target is a PlayStation-family title.

## Two import paths

The default entry point (`@seer-project/playstation`) is **browser-safe** —
no `node:*` imports — so it works in a browser asset viewer as well as
offline pipeline code. File-backed disc I/O (opening a real
`.bin`/`.iso`/`.cue` off disk) lives in the `./node` subpath:

```ts
import { parseTim, decompressLzss } from '@seer-project/playstation';
import { openRawCdImage, loadCue, readCookedDataTrack } from '@seer-project/playstation/node';
```

## Two independent TIM decode pipelines

`psx/tim.ts` intentionally ships **two** BGR555->RGB decode paths rather than
one:

- `tryParseTim`/`scanTimImages`/`decodeTimToRGBA` (returning `TimRecord`) —
  offset-located structural parsing (`scanTimImages` finds every
  self-consistent record in a blob without knowing its position up front),
  `decodeBGR555`'s `round(c*255/31)` channel scaling, and the only path with
  24bpp support.
- `parseTim`/`parseTimIndexed` (returning `TimImage`/`TimIndexed`) —
  parse-at-a-known-offset, `bgr555ToRgba`'s `c << 3` channel scaling, and the
  only path with multi-row-CLUT support (`TimIndexed`, `renderTimRow`) and
  PSX GPU texture-page/CLUT-selector resolution (`TexPageRef`,
  `resolveTexPageRef`, `texRefSourcePixel`).

These were independently verified against two different real games' actual
rendered output, and they disagree on channel scaling. They are kept
separate rather than merged onto one convention, since unifying them without
new evidence would be an unverified behavior change to whichever side lost.
Pick the pipeline that matches what you've already verified against your own
game's data, or verify both against a known-good reference image before
picking one.

## STR/XA: two on-disk shapes, one API

`psx/str-xa.ts`'s `wrapAsCdxa` handles both real on-disk STR/XA shapes:

- **Subheader-stripped, video-only** (`sectorStride` 2048): no CD-XA
  subheader survived extraction. Pass `opts.subheader` to synthesize one.
- **Subheader-preserved, video+audio interleaved** (`sectorStride` 2336, a
  `dumpsxiso`-style "Mode2/2336" extraction): a real subheader is already
  present per sector. Omit `opts.subheader` to copy it through unchanged.

## What's deliberately not here

Everything below stays in its own project rather than shipping in this
package, because it's game-specific rather than a documented PSX/PS2/PSP
platform or SDK format:

- Bespoke actor/model/animation/pose chunk containers (proprietary,
  non-SDK binary layouts specific to one title).
- Video-obfuscation ciphers applied on top of an otherwise-standard FMV
  container (a game-specific key/cipher layer, not a PS2 hardware or SDK
  format).
- Bespoke bounded CPU interpreters written for one game's specific scripting
  needs (not a general-purpose CPU core port).

## Testing

```bash
npm test
npm run lint
```

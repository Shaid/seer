# @seer-project/arcade

Decoders for arcade board ROM sets: MAME zip containers, CPS1/CPS2
gfx+palette+encryption, Neo Geo graphics, and the commodity sound chips
(OKI MSM6295, uPD7759, Capcom QSound) and Sega System 16 tile hardware
that show up across many arcade boards.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Browser + Node safe (no platform-specific imports) — every decoder here
operates on plain `Uint8Array`/`Int16Array` buffers.

## Installation

```bash
npm install @seer-project/arcade
```

## ROM containers

```ts
import { readMameZip } from '@seer-project/arcade';

const files = readMameZip(zipBytes); // Map<string, Uint8Array>, filenames as stored
```

A minimal MAME-style ROM-set ZIP reader (plain PKZIP — store or deflate —
with no dependency on an external unzip library).

## Capcom CPS1/CPS2/CPS3

```ts
import {
  CPS1_LAYOUT_16X16, decodeTile, tileCount, cps2UnshuffleGfx,
  decodeCps1PaletteWords, decodeCps1PaletteWordsForced,
  swapWordBytes, interleaveWords, allocRegion,
  decodeCps2Key20, decodeCps2Key8, cps2Decrypt,
  cps3Mask, cps3DecryptProgram, assembleCps3User5, Cps3CharDma,
  Sh2,
} from '@seer-project/arcade';
```

- `gfx.ts` — generic CPS1/CPS2 `gfx_layout` planar tile decoder (MAME's
  `gfx_element::decode()` port), plus CPS2's per-2MB-bank `unshuffleGfx`.
- `palette.ts` — CPS1/CPS-B palette-RAM word decode (12-bit RGB + 4-bit
  brightness) and copy-site/bank scanners for locating palette data in a
  ROM dump.
- `rom-regions.ts` — MAME `ROM_LOAD16_WORD_SWAP`/`ROM_LOAD64_WORD`-style
  helpers for assembling a flat region out of individual ROM-chip dumps.
- `decrypt.ts` — CPS2 68000 opcode Feistel decryption (both the 8-byte
  hardcoded-key and 20-byte battery-backed-key formats).
- `cps3.ts` — CPS3 SH-2 program-ROM XOR-mask decryption + character DMA
  unswizzle.
- `sh2.ts` — a complete Hitachi SH-2 (SH7600) interpreter, ported
  opcode-for-opcode from FBNeo's `sh2.cpp`, for stepping CPS3's SH-2
  security-cart program.

### OKI MSM6295 ADPCM (`capcom/oki-adpcm.ts`)

```ts
import { OkiAdpcmState, decodeOkiAdpcm, parseOkiPhraseTable, CPS1_OKI_GAIN } from '@seer-project/arcade';

const phrases = parseOkiPhraseTable(okiRom); // { phrase, start, end }[]
const pcm = decodeOkiAdpcm(okiRom.subarray(phrases[0].start, phrases[0].end), CPS1_OKI_GAIN);
```

A byte-for-byte port of MAME's `oki_adpcm_state` (the commodity
Dialogic/VOX-family 4-bit ADPCM chip used across dozens of late-80s/
early-90s Capcom/Konami/Data East arcade boards) plus a reader for the
chip's standard 128-entry phrase (sample directory) table. `CPS1_OKI_GAIN`/
`CPS1_OKI_SAMPLE_RATE` are CPS1's own empirically-tuned amplification/rate
constants, kept alongside the chip decoder since that's the reason this
lives under `capcom/` rather than a platform-neutral location.

### QSound (`capcom/qsound.ts` + `capcom/qsound-driver.ts`)

```ts
import { decodeQsoundPcm, QSOUND_REG, QSOUND_PORT } from '@seer-project/arcade';

const pcm = decodeQsoundPcm(qsoundRom.subarray(start, end));
```

`qsound.ts` is the QSound chip (DL-1425) layer only: raw-ROM-byte-to-PCM
sample decode plus the Z80 mailbox register/port address map. It has no
dependency on any particular game's sound-driver data.

```ts
import {
  parseCps2SeqTable, parseCps2SeqHeader, decodeCps2TrackV1,
  parseQsoundSampleInfoTable, cps2InstrumentAddressV115, parseCps2InstrumentV115,
  parseCps2EnvelopeRateTables, computeCps2EnvelopeTimes,
  parseCps2PitchTables, computeCps2PitchDelta, cps2TempoToSecondsPerTick,
} from '@seer-project/arcade';
```

`qsound-driver.ts` is the separate, larger CPS2 Z80 sound-driver format
that *feeds* the QSound chip: the note-select table, envelope dispatch
table, the CPS2 music-sequence grammar (song table -> per-song track
pointers -> the `CPS2TrackV1` event stream), and the sample-info/
instrument/envelope-rate/pitch tables that resolve a decoded note or
program-change event into real QSound sample-ROM byte ranges and ADSR
timing. Every function takes its ROM region and table addresses as
parameters (they genuinely differ per game); it was first verified
end-to-end against Dungeons & Dragons: Shadow over Mystara's real
`audiocpu` ROM (driver revision `CPS2_V1.15` per vgmtrans's own
classification) — see each function's doc comment for the specific
verification evidence. `decodeCps2TrackV1` is `CPS2_V1.15`-family-generic;
a later driver generation (`CPS2_V140`+) would need vgmtrans's newer
branches ported separately.

## Neo Geo

```ts
import {
  decodeNeogeoSpriteTile, decodeNeogeoFixTile,
  cmcGfxDecrypt, sfixDecrypt,
  decodeNeoGeoPaletteWord, decodeNeoGeoPaletteWords, scanNeoGeoPaletteBanks,
} from '@seer-project/arcade';
```

- `gfx.ts` — sprite (C ROM) and fix-layer (S ROM) tile decoders, ported
  from MAME's `neosprite_optimized_device`/`neosprite_base_device`.
- `cmc.ts` — NEO-CMC (CMC42/CMC50) sprite ROM decryption for the late-era
  encrypted sets (Garou, KOF99, KOF2003, SVC Chaos, etc).
- `palette.ts` — Neo Geo's 15-bit `0RRRRRGGGGGBBBBB` palette-RAM word
  decode, plus a scanner for locating plausible color-word runs in a P
  ROM (palette tables are program-loaded, not a fixed copy-site idiom).

## Sega System 16

```ts
import {
  decodeSega16Tiles8x8, decodeSega16Sprites4bpp, decodeSega16PaletteWord,
  computeResistorWeights, combineWeights,
} from '@seer-project/arcade';
```

`sega/system16-gfx.ts` covers the Sega "System 16" family tile/sprite
graphics and palette-word hardware (System 16A/16B and siblings sharing
the same tilemap/palette hardware — System 18, Out Run family, etc, not
just one game). Palette decode uses a genuine, non-linear
binary-weighted-resistor-ladder DAC curve (`computeResistorWeights`/
`combineWeights`, ported from MAME's `resnet.cpp`), not a naive linear
0-31 -> 0-255 scale — see the module doc comment for how much that
actually changes individual values (small, but real: not a rounding
artifact).

## uPD7759 ADPCM

```ts
import { decodeUpd7759Slave, UPD7759_DEFAULT_GAIN } from '@seer-project/arcade';

const { pcm, terminatedCleanly } = decodeUpd7759Slave(speechRom, sampleStartOffset, UPD7759_DEFAULT_GAIN);
```

`sega/upd7759-adpcm.ts` is a byte-for-byte port of MAME's
`upd775x_device`, decoding the NEC uPD7759 speech/sample chip's
block-header ADPCM grammar in **slave mode** (the mode used when a
driving CPU streams bytes into the chip one at a time via DRQ/NMI, rather
than the chip reading its own ROM directly) — including the 5-byte
slave-mode priming preamble every real slave-mode sample begins with.
Despite the name this chip (and its mask-ROM-only siblings 55/56/57/58)
is a commodity part used across many Sega/Capcom/etc titles, not
Sega-exclusive; it lives under `sega/` because its first real-hardware
verification (Golden Axe) was a Sega System 16 board.

## Yamaha YM2203 (`@seer-project/arcade/yamaha`)

```ts
import { Ym2203Fm, Ym2203Ssg } from '@seer-project/arcade/yamaha';

const fm = new Ym2203Fm(3_579_545); // fm.sampleRate = clock / 72
fm.write(0x28, 0xf0);               // register writes, as the sound CPU made them
const s = fm.sample();              // one FM sample at fm.sampleRate

const ssg = new Ym2203Ssg(3_579_545);
ssg.write(0x08, 0x0f);
const t = ssg.sample(48_000);       // one SSG sample at the caller's output rate
```

Register-driven models of the OPN's FM section (3 channels, 8 algorithms,
envelope generator, detune/MUL, feedback) and SSG section (3 tones, noise,
mixer, 4-bit volume). Both step one sample at a time with no platform
imports, so they suit offline renders and AudioWorklets alike. Checked
against MAME 0.289's ymfm on Black Tiger's music and effects, not against
real silicon. Timers/IRQ, 3-slot/CSM mode, SSG-EG and the SSG hardware
envelope are not modelled.

## License

AGPL-3.0-or-later

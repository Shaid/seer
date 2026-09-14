# @seer-project/snes

SNES hardware primitives: a full SPC700 CPU interpreter, a register-driven
S-DSP audio engine (envelope/GAIN, BRR sample playback, echo, noise, pitch
modulation), and PPU tile/CGRAM graphics decoders. Optional — install only
if your target is a Super Famicom title.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Consolidates a SPC700/S-DSP emulation stack that was independently
duplicated, with drift, across three sibling seer projects before this
package existed — see `docs/package-extraction-plan.md` in the seer
workspace for the extraction history.

## Installation

```bash
npm install @seer-project/snes
```

## What's here

- **`spc700-cpu.ts`** — `Spc700Cpu`: a real SPC700 interpreter (full 64KB
  ARAM, all registers, the complete opcode set, `$F0-$FF` memory-mapped
  I/O), ported from blargg's `snes_spc` and cross-checked against Mesen2.
- **`spc700-dsp.ts`** — `Spc700Dsp`: the full 128-byte S-DSP register file
  driving 8 voices — ADSR/GAIN envelopes, BRR sample decode/playback
  (eager-decode-once, cached), the echo unit, the noise generator (`NON`),
  and pitch modulation (`PMON`) — everything a real SPC700 program writing
  to `$F2`/`$F3` would drive.
- **`envelope.ts`** — `stepEnvelope`/`stepGainEnvelope`: the S-DSP's ADSR
  and GAIN envelope state machines and the 32-entry rate-period table, usable
  standalone (without a full `Spc700Dsp`) by a driver-level renderer.
- **`brr.ts`** — `decodeBrrBlock`/`decodeBrrHeader`: the BRR (Bit Rate
  Reduced) ADPCM-like sample codec, including the real hardware's doubled-
  output 16-bit wraparound quirk.
- **`echo.ts`** — `stepEcho`: the S-DSP echo unit (delay line, 8-tap FIR,
  feedback).
- **`ppu.ts`** — 2bpp/3bpp/4bpp tile decode, tile mirroring, and 15-bit BGR
  CGRAM palette decode.
- **`akao-dsp.ts`** — `noteToResampleStep`/`PITCH_TABLE`/`PITCH_UNITY` and
  `decodeBrrBlob`: the one exception to "hardware only" below. These are
  AKAOSNES sound-driver conventions (Square's driver used by Final Fantasy
  IV/V/VI and Chrono Trigger), traced from the real driver's `CalcFreq`
  pitch routine and its length-prefixed BRR blob container — not S-DSP
  hardware. They were promoted here (rather than left duplicated per
  project) because they were confirmed byte-identical across two
  independent AKAOSNES consumers.

All algorithms are transcribed from real, cited sources (blargg's
`snes_spc`, Mesen2's `Core/SNES`) rather than derived from written
descriptions — see each module's own doc comment for the specific source
function and any known simplifications.

## What's deliberately not here

- **A driver's note-to-pitch/tuning formula, in general.** Real S-DSP
  hardware just plays back a 14-bit pitch register value — how a
  sequencer/driver derives that value from a note number and tuning bytes
  is driver-specific, not hardware. `spc700-dsp.ts` only ever consumes the
  raw register value.
- **Any other "blob" container format for packaging BRR sample data.** Real
  hardware has no such framing — voices reference raw BRR blocks directly
  via the DSP's `DIR` table. A driver's own ROM data convention for storing
  a run of BRR blocks (a length prefix, a directory of pointers, etc.)
  belongs in that driver's own module, built on `decodeBrrBlock`, unless
  (like `akao-dsp.ts`) it's confirmed shared byte-for-byte across more than
  one independent consumer.

These are sequencer/driver conventions, not SNES hardware, and belong in
each consuming project's own driver-level module rather than here — the
`akao-dsp.ts` module above is a deliberately narrow, evidence-gated
exception, not a precedent for folding driver code into this package by
default.

## Usage

```ts
import { Spc700Cpu, Spc700Dsp } from '@seer-project/snes';

const ram = new Uint8Array(0x10000); // load your ARAM image into this
const dsp = new Spc700Dsp(ram);
const cpu = new Spc700Cpu(ram, {
  read: (addr) => dsp.read(addr),
  write: (addr, value) => dsp.write(addr, value),
});

// Drive the CPU, and pull one stereo sample from the DSP every 32 CPU cycles
// it reports having run (`DSP_SAMPLE_RATE` = 32000 Hz).
const [left, right] = dsp.step();
```

Lower-level primitives (`stepEnvelope`, `decodeBrrBlock`, `stepEcho`,
tile/palette decoders) are exported directly for a driver-level renderer
that doesn't need a full register-accurate `Spc700Dsp` instance.

## Licensing & Commercial Use

Seer exists to reverse-engineer other people's work, and that is only possible
because the preservation and romhacking communities published what they found
instead of keeping it. The licence is chosen so that keeps happening: build on
Seer and your work stays open too, so the next person gets the same head start.

- **[AGPL-3.0-or-later](https://github.com/Shaid/seer/blob/main/LICENSE)** —
  free for personal, educational and open-source use. Note that the AGPL extends
  copyleft to **network use**: run a public web app or hosted service on this
  and you must publish your application's source under the AGPL.
- **Commercial licence** — waives that requirement so a proprietary or
  closed-source product can keep its codebase private. Flat-fee and subscription
  terms are available, and custom terms are negotiable.

If the copyleft doesn't fit what you're building, we would much rather have the
conversation than have you walk away — email
[dr.shaid@gmail.com](mailto:dr.shaid@gmail.com) with the subject
`[Commercial License Request - Project Name]`.

Full details: <https://seer.shaid.net/start-here/licensing/>.

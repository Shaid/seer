# `@seer-project/probe` — agent-legible binary recon for 16-bit targets

**Status: implemented.** `@seer-project/probe` now exists
(`packages/probe/`), along with its two prerequisites `@seer-project/gfx`
(`packages/gfx/`) and `@seer-project/amiga` (`packages/amiga/`). See
[`packages/probe/README.md`](../packages/probe/README.md) for the command
reference. The sections below are the original scoping proposal, kept as
the design record; deviations that emerged during implementation:

- **`gfx`'s fourth metric is index *usage*, not compactness.** Rewarding
  sparse index use let a 2N-plane decode of N-plane data win (it uses 11
  of 64 indices and looks "compact"); real art picks its plane count to
  fit its palette, so the shipped metric rewards using the claimed index
  space, plus an explicit redundant-plane penalty.
- **The jitter axis surfaces the parameter combination, not the exact
  byte.** Offsets that preserve the row period decode to a plane-rotated
  image with near-identical statistics, so the precise start byte is not
  recoverable from the score — the contact sheet is what disambiguates it.
- **`cnf --generate`'s string-table carver detects chains of
  NUL-terminated strings, not printable runs** — 68k opcodes are
  frequently printable bytes (a NOP sled is `NqNqNq…`), so "mostly
  printable" would carve real code. Reloc-run pointer-table carving
  requires ≥ 4 consecutive relocated longwords for the same reason
  (isolated relocs are instruction operands).
- **The audio plausibility gates got tighter than proposed**: roughness
  ≤ 0.08 of full scale (the corpus ceiling is ≈ 0.066) plus a
  zero-delta-fraction guard, because a flat bitmap decodes "smooth"
  without being audio.
- The audit's Frontier (6.8%, 76.2% `DC.x`) and Bane (99.5%, 2.5%)
  numbers below were reproduced exactly by `cnf --audit` against the real
  binaries after implementation, and `--generate` takes Frontier's
  declarable coverage from 6.8% to 93.5% (the IRA re-run acceptance test
  is still pending).
- **A sixth command exists: `triage <dir>`** — whole-corpus first
  contact (per-subdirectory extension → dominant-class tables, container
  hits, HUNK/ADF detection, WHDLoad slave labels). Not in the original
  five because the need only became visible in use: the same
  batch-triage scratch script got hand-written for three corpora in a
  row (Moonstone, crawl's `_unexplored_`, amigagames) before being
  promoted, per the rule of three. It found, among others, Eye of the
  Beholder's CPS-wrapped IFF forms and Reunion's Imploder-crunched MODs.
  A second pass added collection-corpus handling (TOSEC's shape: nested
  archives and many duplicate dumps) — ZIP descent with
  CRC-before-inflate dedupe, ADF-filesystem descent, and slave labels.
  A third added partial reads for corpora on network shares, where bytes
  transferred is the real cost: archives are parsed tail-first so a
  duplicate dump costs its central directory rather than its payloads,
  and files over a size threshold are sampled head+tail. Measured on
  triplicated dumps: 63% of bytes avoided, wall time flat. 307 MB local
  resolves to 37,312 logical files, 10,579 duplicates skipped, in under
  a minute.
- **Two more prerequisites landed in `@seer-project/amiga`**, both
  driven by corpus shape rather than the original design: a read-only
  OFS/FFS ADF reader (so a mountable disk is walked, not carved — and
  a RawDIC image is *identified* as such rather than misparsed) and a
  WHDLoad slave parser (286 games in the amigagames corpus
  self-identify with title, year and publisher).
- **`audio`'s container scan works at any offset**, not just 0. The
  first end-to-end acceptance run (Moonstone, a genuinely unsolved
  corpus — see `moonstone/docs/moonstone/amiga/probe-recon.md`) found
  the game's entire sound library shipped as IFF 8SVX forms concatenated
  inside the CODE hunk of HUNK executables, invisible to an
  offset-0-only scan. The shipped scan sweeps validated FORMs across the
  whole file, unwraps HUNK payloads, and writes one WAV per voice at its
  real VHDR rate. That acceptance run also confirmed the
  hypotheses-not-findings rule earning its keep in the other direction:
  a ByteRun1 decode of Moonstone's `.piv` data landed one byte off an
  exact 320×5×139 size — and the sweep correctly scored the output as
  noise (`rle-decode-succeeds-on-garbage`, live).

---

## Context

The corpus is large and the extraction machinery is good, but there is no
exploratory tooling anywhere in the stack. Every reverse-engineering session
re-derives the first hour by hand.

Three independent pieces of evidence point at this as a real, currently
unaddressed gap:

1. **`~/.claude/agents/game-re.md` § "Method — the RE loop"** prescribes, at
   step 3, "throwaway Python (numpy + PIL) in the scratchpad, never
   committed" and "render candidates as greyscale first." That sweep is
   hand-rolled from scratch, per game, per session, and deliberately
   discarded. Step 1 similarly prescribes an entropy scan and a string-gap
   stride histogram by hand.

2. **`~/.claude/agents/game-re-tooling/format-discovery.md`** already names
   the missing tools and says to build them: binocle/binviz, ImageHeat,
   Monkey-Moore, Bin2Obj and biodiff are listed under "GUI tools — for a
   human, not for you … Reimplement the technique instead; each is a short
   script." Its only scriptable recommendation, ReverseBox, covers 100+
   modern-console pixel formats and no 16-bit planar layouts at all. Its own
   negative-result section records that the wider prior-art ecosystem has
   "effectively zero Amiga, Atari ST, Apple IIGS or 68k coverage."

3. **The lessons corpus contains the scar tissue.** Among the ~254 files
   under `~/.claude/agents/game-re-lessons/`:
   `decoded-classified-blob-never-tried-as-pixels.md`,
   `tile-grid-dimension-needs-render-not-just-bytecount.md`,
   `autocorrelation-period-is-the-scanline-stride.md`,
   `committed-ira-asm-silent-coverage-gap.md`,
   `audio-byte-order-measurable.md`,
   `planar-plane-padding-vs-tight-stride.md`. These are lessons that exist
   because recon was skipped or done ad hoc.

Meanwhile `docs/common-tooling-candidates.md` — the 1,305-line cross-repo
audit — is entirely consolidation-focused: it inventories duplication across
existing extractors, not gaps in exploration. Nothing in
`docs/framework-plan.md` or `docs/todos.md` addresses discovery either. This
is a genuinely untouched category, not a duplicate of planned work.

**Intended outcome:** a Node CLI where every command emits both a compact
JSON verdict and an artifact that can be inspected directly — a PNG to look
at, a WAV to listen to, a `.cnf` to feed straight back into IRA.

**Scope of this proposal:** five commands — `map`, `gfx`, `stride`, `audio`,
`cnf` — living in a new `packages/probe`, with the graphics sweep matrix
covering Amiga OCS/AGA only. A pointer/directory-table finder (`ptr`), a
compression-ID wrapper (`sniff`), a relative-search text scanner (`text`), an
alignment diff (`diff`), a float-triple-to-mesh dumper (`mesh`), and a corpus
signature registry are deliberately out of scope for this pass — noted here
so they aren't lost, not because they lack value.

### The rule that governs the whole design

`probe` emits hypotheses, never findings. Lessons
`plausible-render-not-semantic-label.md` and `rle-decode-succeeds-on-garbage.md`
are why. The ground-truth bar in `game-re.md` § "Ground truth before
'decoded'" is unchanged by this tool: a ranked contact sheet is a starting
point for verification, not a substitute for it. Every JSON output carries
`confidence` and its scoring components, and no output field asserts a
decode.

**The one exception is `cnf --audit`**, which reports a measured quantity
(declared-code coverage), not a guess.

---

## Prerequisites: two already-prioritized extractions this pulls forward

`probe` deliberately does not grow its own copies of code the audit already
says should be shared. Both of these are §"Do now" items in
`docs/common-tooling-candidates.md`; `probe` would become their second
consumer and their forcing function.

### `@seer-project/gfx` (audit §1) — Amiga subset only

`probe gfx` needs planar decoding. Writing it inside `probe` would create a
seventh independent `decodePlanar` — precisely the duplication
`common-tooling-candidates.md` §1 documents across crawl, sorcery, strike,
wyrm, nicodemus and middilgard.

So `packages/gfx` should land first, but only the slice this needs — not
§1's full ~500-line surface:

- `decodePlanar(data, { width, height, planes, layout, offset?, planeStride?, rowBytes? })`
  with `layout: 'plane-major' | 'row-interleaved' | 'word-interleaved'`
- `expandColorWord(word, 'amiga12' | 'amiga24')`
- `indicesToRGBA(indices, palette, { transparentIndex?: number | null })` —
  using §1's `number | null` shape, which also avoids `writeIndexedPNG`'s
  hardcoded-index-0 bug (`docs/weaknesses.md` §7)
- `greyscaleRamp(indices, planes)` — the default render for unconfirmed
  palettes

Browser-safe, zero deps, depends only on `@seer-project/core`. The
implementation should be lifted from `strike/tools/shared/amiga-planar.ts`
(the most complete, 282 lines) and reconciled against
`nicodemus/src/assets/formats/bitplane.ts`, whose unified
`bitplaneByteOffset()` formula the audit calls the most elegant of the set.
ST / SNES / Megadrive / EGA decoders would join later, when those platforms
join the sweep matrix.

### `@seer-project/amiga` (audit §9) — HUNK parsing

`probe cnf` needs to walk a loadseg()-able executable's hunk map. Seven
independent implementations of this already exist across four repos, per the
audit. Base it on `strike/tools/shared/amiga-hunk.ts` (all hunks + file
offsets, masks `& 0x3FFFFFFF` on the in-stream tag) — the audit calls it
closest to a superset API and, despite being the best implementation, the one
with no tests at all. `probe cnf` needs hunk type, file offset and size, plus
`HUNK_RELOC32` and `HUNK_SYMBOL` when present.

---

## The five commands

All write `<out>/probe-<cmd>-<name>.*`. Default `--out` is the scratchpad, so
probes stay uncommitted by default, matching the existing convention for
throwaway hypothesis scripts.

### `seer-probe map <file>`

The "what am I looking at" pass. One stacked PNG, shared x-axis = file
offset:

1. **Byte plot** — one pixel per byte, row-major at `--width` (default 512),
   coloured by class: `0x00` black, `0xFF` white, printable ASCII green,
   `0x01–0x1F` blue, high-bit red, else grey. Files over ~1 MB collapse to
   one pixel per N bytes using the window's dominant class.
2. **Entropy ribbon** — Shannon entropy per `--window` (default 256 B).
3. **Class-fraction ribbon** — stacked zero/ascii/high/other per window.
4. **Region bar** — the segmentation, with offsets labelled.

JSON: `{file, size, window, regions: [{start, end, len, class, entropy, confidence, note}]}`
with `class ∈ zero-fill | patterned-fill | ascii-text | packed-records |
planar-graphics? | pcm-audio? | compressed-or-encrypted | m68k-code? | mixed`.

Classifier guardrails, each tied to a specific lesson:

- Test for a short repeating period before calling low entropy "fill" —
  `patterned-fill-defeats-naive-entropy-scan.md`.
- Gate every class assignment on entropy; don't classify on byte shape
  alone — `byte-shape-classifier-needs-entropy-gate.md`.
- `m68k-code?` and `pcm-audio?` are weak hints only, always suffixed `?`,
  never asserted. `m68k-code?` is the fraction of even-aligned words
  decoding to common opcodes.
- High entropy does not imply real compression —
  `high-entropy-trivial-cipher.md`; the `note` field says "compressed or
  encrypted or trivially ciphered."

### `seer-probe gfx <file>` — the contact sheet

The single highest-leverage command. It replaces the entire
write-script → guess → write-PNG → look → edit → repeat loop with one
invocation:

```
seer-probe gfx DDD.BOLT --platform amiga --range 0x400:0x8000
```

`--regions <probe-map.json>` accepts `map`'s JSON output directly and sweeps
each candidate region, so offsets flow between commands as a pipeline rather
than being hand-copied.

Sweep matrix (Amiga OCS/AGA):

| Axis | Values |
|---|---|
| planes | 1–6 (7–8 with `--aga`) |
| layout | `row-interleaved`, `plane-major`, `word-interleaved` |
| width (px) | 16, 32, 48, 64, 80, 96, 128, 160, 176, 192, 256, 288, 320, 352, 640 |
| mask | `--mask` also tries N+1 planes with the last as a mask |
| plane stride | `--plane-stride auto\|<bytes>` — `planar-plane-padding-vs-tight-stride.md` |
| offset jitter | +0…+15 bytes from the given start, so a region boundary that's off by a few bytes doesn't sink every candidate — `leading-header-equal-to-field-offset-masks-record-start.md` |

The `width % 16 == 0` Amiga word-alignment constraint prunes the space
hugely and is what makes an exhaustive sweep cheap.

Render greyscale, opaque, by default — following `game-re.md`'s own rule
("only apply colour once the palette is independently confirmed") and
`transparent-png-preview-tool-artifact.md`. `--palette <file>` opts in to a
real palette.

**Scoring** — four components, reported separately so the ranking can be
argued with rather than trusted:

- *Row coherence* — mean absolute difference between vertically adjacent
  rows. Real bitmaps are far more vertically coherent than a wrong stride.
- *Run structure* — horizontal run-length distribution; art has runs, noise
  doesn't.
- *Shear* — cross-correlate row *n* against row *n+1* at shifts ±k. A wrong
  width produces a consistent non-zero shift (the diagonal-smear signature),
  and the measured shift suggests the correct width — reported as
  `shearHint`.
- *Index compactness* — for N planes, how many of the 2^N indices are used
  and how clustered they are.

Outputs: a labelled grid PNG of the top `--top` (default 24) candidates
sorted best-first, each cell captioned `planes/width/layout · score`; a
full-resolution PNG of the single best candidate; and JSON
`{best, candidates: [{planes, width, layout, planeStride, score, components}], shearHint}`.

Captions need a bitmap font — plan to ship a ~1 KB 6×8 ASCII font as inline
data rather than adding a dependency.

### `seer-probe stride <file>`

Record size and scanline pitch. Codifies
`autocorrelation-period-is-the-scanline-stride.md` and `game-re.md`'s own
triage tip about histogramming string-start gaps.

Three signals, combined:

- Byte self-similarity: for stride *s*, normalised mean `|b[i] − b[i+s]|`;
  minima are candidate periods.
- Equality rate: fraction of positions where `b[i] == b[i+s]`.
- String-gap histogram: find ASCII run starts, histogram consecutive gaps,
  report dominant values.

Fold harmonics — report the fundamental, not 2*s* and 3*s*. Guard against
`next-record-preview-defeats-stride-detection.md` by reporting all strong
fundamentals rather than only the top one.

For the best candidate, also emit a record-grid PNG: the file rendered as a
`stride`-wide byte image, so constant/zero columns show up as visible
stripes and the record's field layout becomes readable at a glance. Plus
JSON: `{candidates: [{stride, score, signals, constantColumns}]}`.

### `seer-probe audio <file>` — the listen sheet

The audio analogue of `gfx`, but the parameter space is far smaller: no
layout zoo, just `{sample rate, bit depth, signedness, mono/stereo, byte
order}`.

**The detection statistic already exists and is already validated in this
corpus.** `audio-byte-order-measurable.md` establishes mean absolute
sample-to-sample difference as the discriminator, measured on Spirit of
Excalibur CDTV across 26 CD tracks: correct byte order scored 700–4,300,
byte-swapped scored ~21,800 — roughly two-thirds of full scale, unanimous
across every track. The same lesson notes it doubles as an "is this audio at
all?" gate, since a filesystem or bitmap read as PCM also yields a large
first difference. So this command implements a measured technique, not a
guessed one.

Second statistic, also already present in this corpus:
**lag-1 autocorrelation**, used in
`middilgard/src/assets/formats/legend-xfsd.ts`'s docblock to justify the
XFSD decode (good resources scored 0.514–0.979, median 0.824). It's
currently the one "is this audio?" statistic anywhere in the corpus that
isn't shipped as reusable code — this promotes it.

Three-stage design:

1. **Container signature scan first** — free ground truth when it hits. The
   magic list is already enumerated in
   `hunter/tools/hunter/extract-carrier-music.py`: `M.K.`, `M!K!`, `FLT4`,
   `FLT8`, `8CHN`, `4CHN`, `OCTA`, `CD81`, `FORM`/`8SVX`/`16SV`, `MMD0`,
   `MMD1`, `MED `, `SMUS`, `SONX`. Reuse `@seer-project/iff`'s
   `parseIff`/`findChunk` for the IFF family — and for 8SVX specifically,
   `@seer-project/smus`'s existing `parse8svx`/`isIff8svx`
   (`smus/src/sampled-sound.ts`), which already decode VHDR and therefore
   yield a real `samplesPerSec` — the one parameter stage 2 below cannot
   recover. Reuse `@seer-project/tracker`'s standalone `Module` parser for
   MOD variants. Also reuse strike's
   structural check — `isSelfContainedModule`'s size-closure invariant
   (`1084 + patterns*1024 + Σ sampleWords*2 === fileLength`,
   `strike/tools/desertstrike/audio.ts`), the closest thing in the corpus to
   a real structural audio detector.
2. **Raw-PCM parameter sweep** when no container matches — score every
   `{signed|unsigned} × {8|16-bit} × {BE|LE} × {mono|stereo}` combination on
   the two statistics above, over the whole file or over regions taken
   directly from `map`'s JSON via `--regions`. Both statistics must be
   normalised to full scale so their thresholds are bit-depth-independent —
   the lesson's figures (700–4,300 vs ~21,800) are 16-bit absolute values
   and don't transfer to 8-bit unscaled. Run the sweep per file, never once
   per format — the byte-order lesson records a real case (Chaos Legion)
   shipping 15 of 16 clips one way and one the other, with byte-identical
   sub-headers.
3. **Emit both artifacts.** A spectrogram grid PNG for visual triage (wrong
   byte order reads as flat broadband noise, right order shows HF roll-off
   and transient structure — the lesson's own `ffmpeg -lavfi showspectrumpic`
   observation), and normalized WAV snippets of the top-N candidates. The
   WAVs are the real win here: audio has a discovery mode graphics doesn't —
   play five two-second clips and the answer is immediate.

Sample rate is deliberately not guessed from the signal — it isn't
recoverable from raw PCM. Report it as unknown unless a header supplies it.
This matters because every sample rate anywhere in the current corpus is
either hardcoded or guessed: `INFERRED_SAMPLE_RATE_HZ = 8287` (strike DMCA,
carrying a literal `sampleRateConfirmed: false` field),
`FALLBACK_SAMPLE_RATE_HZ = 8000` (middilgard XFSD),
`ASSUMED_SAMPLE_RATE = 8000` (hunter Carrier Command), `16726`
(`smus/src/sampled-sound.ts`'s `instrSampleRate`), and `argv[3] ?? 8000`
(sorcery `decode-sound.ts`). `probe audio` should make that uncertainty
explicit in its JSON rather than inheriting the habit of burying it in a
constant.

Reuse for output: `writeWav` (`packages/pipeline/src/io.ts:67`) — its 8-bit
path is unsigned with no signed-8 path, so a signed-8 source needs
converting first, the way `strike/tools/shared/wav.ts`'s `signed8ToPCM16`
does. Snippet resampling can reuse `resampleLooped` from
`@seer-project/audio-dsp`.

**Out of scope for `audio`:** FM-synth register blocks (Genesis YM2612
dumps, OPL patches) and Phantasie-style register/waveform music aren't
waveforms — they're structured tables, so they belong to `map`/`stride`
rather than a signal-detection command.

### `seer-probe cnf <executable>` — IRA config generation and audit

IRA cannot reliably separate code from data, and
`~/.claude/agents/game-re-tooling/amiga.md` documents it failing in both
directions: on a large hand-optimized binary, `-preproc` declares almost
nothing as code; on a small single-CODE-hunk loader it overcorrects the
other way (a 15 KB Jungle Strike loader classified as ~32 bytes of code
total). The documented fix in both cases was hand-adding an explicit
`CODE $start - $end` covering the containing hunk — which took one
Wizardry 6 binary from ~1.5% to 99.47% declared-code coverage in one edit.

`committed-ira-asm-silent-coverage-gap.md` names the consequence: a `.cnf`
left at raw, under-covering `-preproc` output "doesn't error or look
broken — it can sit committed and trusted as a search surface for multiple
sessions before anyone checks its actual coverage."

**That is happening right now.** Measured directly, across the `.cnf` files
already committed in sibling repos. Coverage here is declared-CODE bytes over
**CODE-hunk payload bytes** (from a hunk parse of each binary) — not over
file size, which would wrongly count hunk headers, reloc tables and
DATA/BSS in the denominator:

| Binary | CODE-hunk payload (bytes) | Declared CODE (bytes) | Coverage |
|---|---|---|---|
| `sorcery` Bane | 351,292 | 349,446 | **99.5%** (hand-fixed) |
| `wyrm` dune | 123,264 | 62,072 | 50.4% |
| `crawl` BlackCrypt | 12,496 | 5,134 | 41.1% |
| `hunter` Frontier | 633,492 (10 CODE hunks) | 43,288 | **6.8%** |
| `middilgard` WarInMiddleEarth | 114,708 | 1,830 | **1.6%** |
| `nicodemus` PhantasieIII | 137,352 | 1,674 | **1.2%** |

The Bane row validates the metric itself: 99.5% reproduces the 99.47%
`amiga.md` independently documents for that same hand-fixed binary. And
100% is not the target — CODE hunks legitimately embed data
(`hunk-wraps-non-code-data.md`), so Bane's ~99.5% is the empirical ceiling.

Cross-checking the committed `.asm` files by their `DC.x` directive ratio
separates real damage from latent traps: WIME (8.0% `DC.x`) and
PhantasieIII (9.2%) were generated with IRA's plain default pass, so their
`.asm` is actually fine — the low-coverage `.cnf` is only a trap for
whoever next runs `-config` on it. But **`Frontier.asm` is 76.2% `DC.x`** —
43,832 of its 57,518 lines are data directives. That is the committed
search surface everyone greps against for Frontier today, and it's mostly
`DC.W` soup misclassified as data. Bane, by contrast, is 2.5% `DC.x`.

Two modes:

**`--audit <file.cnf>`** — the cheap, high-value half. Parse the `.cnf`,
parse the binary's hunk map, and report declared-CODE coverage per CODE hunk
and overall (denominator = CODE-hunk payload bytes, as in the table above),
naming which of the two documented `-preproc` failure modes the numbers
indicate. Optionally cross-check a sibling `.asm`'s `DC.x` ratio.
This is a measurement, not a hypothesis, and it turns what is currently a
silent multi-session failure mode into a one-line check.

**`--generate`** — emit a `.cnf`. The design principle is an asymmetry
worth stating explicitly: per `amiga.md`, IRA's plain default pass "treats
the whole hunk as code, falling back to `DC.W` only where a byte pattern
genuinely fails to decode" — so over-declaring CODE degrades gracefully,
while under-declaring fails silently. The generator should therefore invert
`-preproc`'s approach: don't try to find code, declare whole CODE hunks as
code, and carve out only high-confidence data islands —

- long zero runs; ASCII string tables (emit `TEXT`, an IRA-supported
  directive)
- jump tables — runs of longwords that are plausible in-hunk addresses
- embedded graphics/audio regions, reusing `probe map`'s region classifier
- `HUNK_RELOC32` targets, which positively identify longwords that are
  pointers — a strong, free data signal
- `HUNK_SYMBOL` entries, emitted as `SYMBOL` directives — free real names.
  `game-re.md` step 2 already instructs checking for `HUNK_SYMBOL` before
  anything else on Amiga.

Exact `.cnf` syntax, confirmed by reading the 27 committed files rather than
inferred from the tool's docs (directive counts across all of them: `CODE`
1,530, `SYMBOL` 136, `OFFSET`/`MACHINE`/`ENTRY`/`END` 27 each, `TEXT` 6,
`LABEL` 5, `DATA` 3):

```
MACHINE 68000
ENTRY $00000000
OFFSET $00000000
CODE $00000000 - $00055032
...
END
```

Address arithmetic must use `amiga.md`'s formula —
`IRA_addr = file_offset + (SECSTRT_n_addr − hunk_n_file_data_start)`, both
sides read straight off the hunk header parse. The generator should also
surface `-LABEL=1` as recommended companion guidance, since IRA's default
`-LABEL=0` numbers labels by branch-target discovery order, not address —
a common source of confusion when cross-referencing against a second,
address-labelled disassembly of the same binary.

---

## Prior art: QuickBMS

Worth a short, honest note, since it prompted part of this proposal.

QuickBMS is already the first entry in
`~/.claude/agents/game-re-tooling/format-discovery.md`'s prior-art table,
cited for its script database — "even when you don't run QuickBMS, the
script *is* the format spec." The tool isn't new to the knowledge base; the
`LittleBigBug/QuickBMS` repo is a GPL-2.0 GitHub mirror of Luigi Auriemma's
original, with no added features. The main BMS script corpus itself lives
on aluigi's own site rather than in that repo — its `scripts/` directory
surfaced only `reimport*.bat` helpers on inspection, though the listing
fetched was truncated, so treat that as provisional rather than exhaustive.

**Structurally, QuickBMS solves the opposite problem.** It extracts known
formats given a script that already describes them; `probe` generates
hypotheses about unknown ones. They sit at opposite ends of the same
pipeline, so there's nothing to build on directly here — and the coverage
gap is real and already documented independently:
`format-discovery.md`'s own negative-result section found the whole
game-modding format ecosystem has effectively zero Amiga/Atari ST/68k
content, QuickBMS's script library included.

Three things are still genuinely worth taking from it, for later work:

1. **The 100+ built-in codec list as a checklist** for a future `probe
   sniff` — includes retro-relevant entries (aplib, lzh, lzx, lzo, lzss,
   PPMd) beyond what the already-installed `ancient` CLI covers.
2. **`findloc` + `clog` as the operation model** for `sniff`: scan for a
   byte pattern, then attempt decompression at that offset rather than only
   at file offset 0. That's the right framing for embedded payloads inside
   a larger container.
3. **The insight that one artifact can be both spec and executable
   extractor** — arguably a better answer to this codebase's actual
   recurring problem (every format currently lives twice: prose in `docs/`,
   TypeScript in `tools/`) than a Kaitai-style DSL would be, since BMS
   handles compression natively via `clog` and Kaitai does not, and BMS is
   already the community's lingua franca for this. Still out of scope for
   this proposal, but if a signature registry is ever built, BMS is the
   model to study rather than Kaitai.

---

## Proposed file layout

**New — `packages/gfx/`** (audit §1, Amiga subset)
`package.json`, `README.md`, `tsconfig.json`,
`src/{index,planar,palette,rgba}.ts`, `src/__tests__/planar.test.ts`.

**New — `packages/amiga/`** (audit §9, HUNK)
`package.json`, `README.md`, `tsconfig.json`, `src/{index,hunk}.ts`,
`src/__tests__/hunk.test.ts` — the tests strike's version is missing.

**New — `packages/probe/`**
`package.json` (`bin: { "seer-probe": "./bin/seer-probe.mjs" }`),
`README.md`, `tsconfig.json`, `bin/seer-probe.mjs`,
`src/index.ts`, `src/cli.ts`,
`src/map.ts`, `src/gfx.ts`, `src/stride.ts`, `src/audio.ts`, `src/cnf.ts`,
`src/classify.ts` (shared region classifier, used by `map` and `cnf`),
`src/score.ts` (gfx's four metrics plus audio's roughness/autocorrelation
statistics), `src/render.ts` (contact-sheet compositor, spectrogram, inline
bitmap font), `src/__tests__/`.

Node-only. Would depend on `@seer-project/core` (`binary.ts`'s non-throwing
`r8`/`r16`/`r32` are exactly right for speculative probing),
`@seer-project/gfx`, `@seer-project/amiga`, `@seer-project/iff`,
`@seer-project/tracker`, `@seer-project/audio-dsp`, and
`@seer-project/pipeline` for `readBinary`/`writePNG`/`writeJson`/`writeWav`
(`packages/pipeline/src/io.ts`). Should use `writePNG` (RGBA), not
`writeIndexedPNG` — the latter carries the transparent-index bug in
`docs/weaknesses.md` §7.

**Other touch points, if this proceeds**
- root `package.json` — add a `probe` npm script; `workspaces:
  ["packages/*"]` already picks the new packages up.
- `docs/common-tooling-candidates.md` §1 and §9 — record once the Amiga
  planar slice and HUNK parser land, and what of each remains
  (ST/SNES/MD/EGA decoders and atlas-pack for §1; reloc decoding and
  `buildHunkExe` for §9).
- `docs/probe.md` (this file) — becomes the command reference once built.
  Note it is **not** auto-published: `wwwdocs/scripts/sync-docs.mjs` syncs an
  explicit `DOC_SOURCES` allowlist, which deliberately excludes proposals and
  internal audits (its own comment names `engine-3d-proposal.md`,
  `weaknesses.md`, `common-tooling-candidates.md`). This doc stays
  repo-internal unless it is added to that list once the tool ships — an
  editorial decision, and the `~/.claude/` citations here would need trimming
  first, since those paths are account-local and don't belong on the public
  site.
- New skill `~/.claude/skills/probe-recon/` — the recon-first loop, how to
  read each output, and the hypotheses-not-findings rule. A separate pass,
  after the package works.
- `~/.claude/agents/game-re.md` § Method steps 1 and 3 — replace the
  hand-rolled Python instructions with `seer-probe` invocations, routed
  through `Skill: re-learn`. `game-re.md` is currently 92.6 KB against its
  own stated ~20 KB budget, so this edit needs to be a net deletion, not an
  addition.
- `~/.claude/skills/ira-disasm/SKILL.md` — add the `--audit` check to the
  refine-and-repeat loop, as the thing to run before trusting an existing
  committed `.asm`.
- `~/.claude/agents/game-re-tooling/format-discovery.md` — add `seer-probe`
  above the "GUI tools — for a human, not for you" table, since it would
  implement several of the techniques that table says to steal.

---

## Verification plan

**Unit (CI, synthetic fixtures — no corpus needed)**
- `gfx`: generate a known indexed image, encode it at a known
  `(planes, width, layout, planeStride)`, assert the sweep ranks the truth
  #1 and that `shearHint` recovers the width from a deliberately
  mis-strided run.
- `stride`: synthesise a 37-byte record array, assert 37 is the top
  fundamental and that 74/111 are folded out; assert `constantColumns`
  matches the fields left zero.
- `map`: synthesise a file with known zero-fill / patterned-fill / ASCII /
  random regions and assert the segmentation boundaries and classes,
  including that patterned fill is not reported as zero-fill.
- `audio`: synthesise a sine/speech-like signal, byte-swap it, and assert
  the full-scale-normalised roughness statistic separates the two decisively
  (the margin `audio-byte-order-measurable.md` documents, restated as a
  fraction of full scale — its absolute figures are 16-bit-specific); assert
  a bitmap and a filesystem image both score as not-audio.
- `cnf`: build a synthetic HUNK executable with known CODE/DATA/BSS hunks
  and a planted string table; assert `--generate` declares the code hunks
  fully and carves the string table as `TEXT`; assert `--audit` reports the
  correct coverage percentage.
- Negative controls throughout — a random-bytes buffer must score low on
  `gfx` and `audio`, otherwise the scores are measuring nothing.

**Corpus regression (opt-in, `skipIf` on data availability, run from the
consumer repos where `data/` actually lives)**

Assert probe recovers parameters that are already independently confirmed:
- Wings `DDD.BOLT` `flags1=0x12` blitter frames — hunter, 932/932 confirmed.
- A Black Crypt `bcdfx` wall graphic — crawl.
- Wings 8SVX instruments — hunter, 4 confirmed; and Legend XFSD, whose
  header carries a real declared `sampleRate` to check `audio`'s reported
  "unknown" against, since XFSD's own is a known value.
- `cnf --audit` against all 27 committed `.cnf` files — assert it
  reproduces the coverage table above, and in particular that Bane lands at
  ~99.5%, matching the 99.47% figure `amiga.md` documents independently for
  that binary.

This is the point at which the corpus starts paying back: the solved
formats become the test oracle for the discovery tool itself.

**End-to-end acceptance (the real test)**

Run `map` then `gfx`/`audio`/`stride` against a genuinely unsolved blob from
`hunter/data/explore/` — the 15-game exploration corpus with open
`TODO.md` rows — and check whether the output produces a usable hypothesis
that disassembly then confirms. If it doesn't beat the current hand-rolled
loop on a real unknown, the scoring heuristics need work before the skill
is written.

For `cnf`, the acceptance test is concrete and already identified:
regenerate `Frontier.cnf` and re-run IRA with `-config`. Success is
`Frontier.asm` dropping from 76.2% `DC.x` to something near Bane's 2.5%.

**Hygiene**
`npm run lint`, `npx tsc --noEmit`, `npm test` at the seer root, plus
`node scripts/verify-consumer.mjs` to confirm the new packages install and
build in a consumer context.

---

## Explicitly out of scope

- **No GUI or TUI.** The consumer is an agent with vision and ears plus a
  human reading PNGs and playing WAVs. A web UI would be a distraction from
  the thing that makes this new.
- **No format DSL in this pass.** See the QuickBMS section above — if this
  is revisited later, BMS is the model to study rather than Kaitai, since it
  handles compression natively. `common-tooling-candidates.md` §17's ruling
  that bespoke codecs are the product and shouldn't be abstracted still
  stands either way.
- **No reimplementation of `ancient`, `vgmstream`, or `ffmpeg`.** `ancient`
  is installed at `~/.local/bin/ancient` and already covers
  PowerPacker/RNC/XPK byte-exactly; a future `probe sniff` should wrap it,
  not replace it. Note that `vgmstream-cli` is referenced by several
  lessons as though runnable but is not currently on `PATH`.
- **No 8SVX Fibonacci-delta decoding or IFF `CAT `/`LIST` recursion.** Both
  are real gaps in `@seer-project/iff`, but they belong to that package, not
  here.

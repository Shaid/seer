# @seer-project/probe

Agent-legible binary recon for 16-bit targets — the exploratory front end
of a reverse-engineering session. Every command emits a compact JSON
verdict plus an artifact you can inspect directly: a PNG to look at, a WAV
to listen to, a `.cnf` to feed straight back into IRA.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

**The rule that governs the whole design: probe emits hypotheses, never
findings.** A ranked contact sheet is a starting point for verification,
not a substitute for it — every JSON output carries its score components
so a ranking can be argued with, and no output field asserts a decode. The
one exception is `cnf --audit`, which reports a measured quantity.

## Installation

```bash
npm install @seer-project/probe
```

## The commands

Artifacts default to a temp scratch directory (probes stay uncommitted by
default); override with `--out <dir>` or `SEER_PROBE_OUT`. Artifacts are
named `probe-<cmd>-<basename>[-0x<range>]…` — partial ranges are suffixed
so repeated `--range` runs coexist, but two *different files with the
same basename* (`Disk.1` from two games) still collide: give each its
own `--out` directory.

### `seer-probe triage <dir>`

Whole-corpus first contact: walks a directory tree and reports, per
game, an extension → dominant-class table, every container hit (IFF at
any offset, MOD, HUNK-wrapped), HUNK/ADF counts, and each group's
WHDLoad slave label — the ranked work-list a recon session starts from.
`.info`/`.uaem` sidecars are skipped.

**Grouping** follows the corpus shape. An installed corpus groups by
top-level directory. A flat collection of per-release archives groups by
**TOSEC title** — `Title (year)(publisher)[flags]` — so the cracks,
alternates and trainers of one game collapse onto a single entry rather
than one per release (29,199 archives → 4,270 games in the TOSEC Amiga
ADF set). Names that don't follow the convention group by filename stem.

Built for collection-shaped corpora (TOSEC and friends), which nest and
duplicate heavily, and for reading them **over a network share**, where
bytes transferred — not CPU — is the cost that matters:

- **ZIP archives are read tail-first.** The central directory carries
  every member's CRC-32 and lives at the end of the file, so listing an
  archive costs a ~1 KB tail probe plus the directory (the probe is
  sized for real collections: TOSEC torrentzips every archive, which
  appends a comment that pushes the EOCD off the last 22 bytes — a
  22-byte probe missed 100% of the time there). Members already seen are
  skipped without ever transferring their payloads, and new members are
  read by byte range. On a corpus holding three copies of each dump this
  avoids **63% of all bytes** (ceiling: 67%), with wall time flat as
  nominal size triples.
- **ADF images with a walkable AmigaDOS filesystem are descended into**,
  each contained file triaged individually and deduped by content — a
  TOSEC game averages several release variants whose *disks* differ
  (crack intros, patches) while most files on them are identical, so
  without content dedupe the per-game file counts inflate by the variant
  multiplicity. RawDIC/trackloader images stay opaque blobs, which is
  itself signal: a `DOS` bootblock whose root block doesn't parse means
  a custom layout.
- **Container hits count media containers only.** HUNK executables are
  reported via their own column/flag, not as "containers" — before this
  distinction, executable markers made up 81% of a corpus's "containers
  found" and drowned the number that matters.
- **Files over `--full-read-mb` (default 8) are sampled**, not read
  whole: 1 MB from the head and 1 MB from the tail. Their class and
  container hits therefore come from a prefix, and their dedupe key is
  (size, head CRC, tail CRC) rather than a whole-file CRC — strong, but
  not an identity proof. The report counts these as `sampledFiles` so
  the distinction stays visible instead of being quietly assumed.
- `--no-descend` treats every file as a blob.

Every run reports **bytes actually read against bytes on disk**, so the
saving is measured rather than claimed. Note that the saving depends on
the corpus actually containing byte-identical payloads: TOSEC's variant
naming (`[cr]`, `[a]`, `[t]`) mostly reflects *modified* dumps, so its
duplicate rate is far lower than the filenames suggest.

Retained container examples are capped per group and per run; hit counts
stay exact, so the report stays a bounded size at any corpus scale.

A 307 MB local collection resolves to 37,312 logical files with 10,579
exact duplicates skipped in under a minute.

### `seer-probe map <file>`

The "what am I looking at" pass. One stacked PNG (byte-class plot, entropy
ribbon, class-fraction ribbon, labelled region bar) plus a JSON
segmentation into classes like `zero-fill`, `patterned-fill`,
`ascii-text`, `packed-records`, `compressed-or-encrypted` — and the weak
hints `planar-graphics?`, `pcm-audio?`, `m68k-code?`, which keep the `?`
in the class name itself so nothing downstream can read them as findings.
The JSON's `regions` array feeds the other commands directly:

```bash
seer-probe map GAME.BIN --out /tmp/recon
seer-probe gfx GAME.BIN --regions /tmp/recon/probe-map-GAME.BIN.json
```

### `seer-probe gfx <file>` — the contact sheet

Sweeps the Amiga OCS/AGA planar space over a range — planes 1–6 (–8 with
`--aga`) × three layouts × fifteen word-aligned widths × a 0–15-byte
offset-jitter axis (`--mask` adds mask-plane variants, `--plane-stride`
overrides plane-major padding) — and writes a ranked, captioned
contact-sheet PNG, a full-resolution PNG of the best candidate, and JSON
with four separately-reported score components (row coherence, run
structure, shear, index usage). A wrong width shows up as a measured shear
and is reported back as `shearHint: <the width to try instead>`.

Greyscale and opaque by default; `--palette <file>` opts into colour once
a palette is independently confirmed.

Known limit, by design: byte offsets that preserve the row period decode
to a plane-rotated image with near-identical statistics, so the *exact*
start byte is not recoverable from the score alone — the jitter axis
exists to keep a misaligned region competitive, and the contact sheet
(wrong colours, shifted fringes) is what disambiguates the offset.

### `seer-probe stride <file>`

Record-size and scanline-pitch finder: byte self-similarity + equality
rate + the ASCII-run-start gap histogram, with harmonics folded in both
directions (a chance-favoured 21× multiple can outscore the fundamental).
All strong fundamentals are reported, not just the top one — a record
whose tail previews the next record honestly has two. The best candidate
also gets a record-grid PNG with constant columns marked, so the field
layout is readable at a glance.

### `seer-probe audio <file>` — the listen sheet

Container signatures first, at **any offset**, not just 0: IFF FORMs are
swept across the whole file (validated against their own size field), a
HUNK executable gets each hunk payload scanned separately — real games
ship whole sound libraries as 8SVX forms concatenated inside a CODE hunk
— and every 8SVX voice found becomes its own WAV at its real VHDR rate,
the only place a sample rate can come from. MOD detection uses the
tracker loader plus the size-closure structural check; MED/SONX by magic. When nothing matches,
a raw-PCM sweep scores every `{signed|unsigned} × {8|16} × {BE|LE} ×
{mono|stereo}` combination on two corpus-validated statistics: normalized
roughness (the measured byte-order discriminator) and lag-1
autocorrelation, plus a flatness guard so solid-fill bitmap bytes don't
pass as "smooth". Artifacts: a spectrogram grid PNG and WAV snippets of
the top candidates — played back at an explicitly *assumed* rate that the
JSON labels as assumed, because raw PCM cannot reveal its sample rate and
pretending otherwise is how wrong constants get committed.

### `seer-probe cnf <executable>` — IRA config audit and generation

- `--audit <file.cnf>`: measures declared-CODE coverage against the
  binary's CODE-hunk **payload** bytes (never file size) and names which
  documented `-preproc` failure mode the numbers indicate. `--asm` adds
  the `DC.x`-ratio cross-check. This is the one probe output that is a
  measurement, not a hypothesis.
- `--generate`: emits a `.cnf` that inverts `-preproc`'s approach —
  declares whole CODE hunks as code (over-declaring degrades gracefully;
  under-declaring fails silently) and carves only high-confidence data
  islands: long zero runs, chains of NUL-terminated strings as `TEXT`,
  and pointer tables identified by runs of consecutive `HUNK_RELOC32`
  offsets (isolated relocs are instruction operands, not data).
  `HUNK_SYMBOL` entries become `SYMBOL` directives. Pair with
  `ira -config`, and consider `-LABEL=1` for address-ordered labels.

## Programmatic API

The pure analysis half of every command is exported — `analyzeMap`,
`sweepGfx`, `analyzeStride`, `sweepAudio`, `generateCnf`, `auditCnf`,
`classifyRegions` and the underlying statistics — so tools and tests can
call them without touching the filesystem.

## License

AGPL-3.0-or-later

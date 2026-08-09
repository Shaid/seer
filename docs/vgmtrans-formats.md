# VGMTrans Format Catalog

A breadth survey of every sequence/instrument format
[VGMTrans](https://github.com/vgmtrans/vgmtrans) (`src/main/formats/`) has a
working reader for, so a seer-framework project that hits an unfamiliar
console audio format can check here first before reverse-engineering it from
scratch. `ceres` used `AkaoSnes/AkaoSnesSeq.cpp` this way to fix a
`LOOP_START`/`LOOP_END`/`LOOP_BREAK` bug in its own FFVI sequence-format
decoder — see "Using this as an oracle" below.

**Method.** Fetched the full `src/main/formats/` tree via GitHub's tree API
(38 directories: 37 format families + `common/`, shared base classes used by
all of them). For each, read the `*Format.h` (and `*Definitions.h` where
present) for the platform/target and any version enum listing known games,
and skimmed the `*Scanner.cpp` signature-detection code where the header
carried no game list. Game names below are only ones the source itself
names (usually in a `enum FooVersion` comment or a scanner docblock) — not
filled in from outside knowledge except where explicitly marked as such.
Not a per-format deep dive; that's what a project does later when it
actually needs one of these.

## Using this as an oracle — and its limits

VGMTrans ships two very different kinds of code per format:

1. **The reader** (`*Seq.cpp`/`*Scanner.cpp`/`*Instr.cpp` — parses the
   binary control flow: loops, jumps, note/param opcodes, instrument
   tables). This is a real, working implementation checked against real
   game files by the project's own contributors and is a reasonably strong
   independent oracle for a format's actual parsing semantics.
2. **The exporter** (MIDI/DLS/SF2 conversion — approximates the target
   format's semantics in a different target format). This is separate code
   and is known to have real approximation bugs in places; it optimizes for
   "sounds right in a DAW," not "byte-exact re-implementation of the
   original driver."

**Only trust the readers, and even then, cross-check against real ROM/disc
bytes before relying on one for a specific game** — the same discipline
this framework already applies to every other oracle. Concretely: this
session used `AkaoSnes/AkaoSnesSeq.cpp` to fix `ceres`'s FFVI sequence
decoder, which had gotten the loop-nesting mechanism wrong. AkaoSnesSeq.cpp
correctly modeled `LOOP_START`/`LOOP_END`/`LOOP_BREAK` including a subtle
"+1 if nonzero" adjustment applied to the raw loop-count byte — a detail
`ceres`'s from-scratch implementation had missed. That fix came from
reading the *reader*, not from trusting any MIDI it exported.

## Shared infrastructure (`common/`)

Not a format — base classes most format directories build on: `Format.h`
(the `BEGIN_FORMAT`/`USING_SCANNER`/`USING_MATCHER`/`USING_COLL` registration
macros), `FilegroupMatcher`/`GetIdMatcher`/`FilenameMatcher` (generic
strategies for grouping a detected sequence with its instrument/sample
files), `PSXSPU.h` (shared PS1 SPU-ADPCM sample-collection scanning, reused
by `HOSA`, `PS1`, and others), `MAMELoader.h` (arcade ROM-set loading, used
by the CPS/Konami arcade formats), and `Modulation.h`
(vibrato/tremolo LFO modeling shared across several SNES formats). Worth
knowing about on its own: it's the shared vocabulary a new format's
`Format.h` will almost always plug into rather than reinvent.

## SNES formats

By far the largest group (18 of 37). Each is a distinct sound-driver
family, not a distinct game — SNES developers/studios largely wrote (or
licensed) their own driver, so the split here tracks *who wrote the driver*,
not *which game*.

| Directory | Driver family | Known games (from source) | Exports |
|---|---|---|---|
| `AkaoSnes` | SquareSoft's AKAO SNES engine, 4 major versions | V1: Final Fantasy 4. V2: Romancing SaGa. V3: Final Fantasy 5, Hanjuku Hero, Seiken Densetsu 2, Final Fantasy Mystic Quest. V4: Romancing SaGa 2, Live A Live, **Final Fantasy 6**, Front Mission, Chrono Trigger, Romancing SaGa 3 | seq, instr |
| `AsciiShuichiSnes` | ASCII Corporation / Shuichi Ukai | not named in source | seq, instr |
| `CapcomSnes` | Capcom, 3 versions | V1: U.N. Squadron, Super Ghouls 'N Ghosts. V2: Aladdin, Magical Quest Starring Mickey Mouse, Captain Commando. V3: Mega Man X | seq, instr |
| `ChunSnes` | Chunsoft, 2 versions (Summer/Winter) each with sub-versions | Summer: Otogirisou. Winter: Dragon Quest 5, Torneco no Daibouken: Fushigi no Dungeon, Kamaitachi no Yoru | seq, instr |
| `CompileSnes` | Compile | Super Aleste (Space Megaforce), Jaki Crush, Super Puyo Puyo, Super Nazo Puyo (1995+) | seq, instr |
| `FalcomSnes` | Falcom | Ys V | seq, instr |
| `GraphResSnes` | Graphic Research | Mickey no Tokyo Disneyland Daibouken | seq, instr |
| `HeartBeatSnes` | Heartbeat | Dragon Quest 6, Dragon Quest 3 (remakes) | seq, instr |
| `HudsonSnes` | Hudson, 3 versions | V0: Super Bomberman 2, Hagane. V1: Super Bomberman 3, Super Genjin 2, Caravan Shooting Collection. V2: An American Tail: Fievel Goes West, Do-Re-Mi Fantasy, Tengai Makyou Zero, Super Bomberman 4/5, Kishin Douji Zenki 3, Same Game, Bomberman B-Daman | seq, instr |
| `ItikitiSnes` | "Itikiti" (part of SquareSoft's SNES family per README, alongside AKAO/SUZUKI) | not named in source | seq, instr |
| `KonamiSnes` | Konami, 6 versions | V1: Contra 3. V2: Madara 2. V3: Pop'n TwinBee. V4: Ganbare Goemon 2. V5: Ganbare Goemon 3. V6: Animaniacs | seq, instr |
| `MoriSnes` | Akihiko Mori | Gokinjo Boukentai | seq, instr |
| `NamcoSnes` | Namco | Wagyan Paradise | seq, instr |
| `NeverlandSnes` | Neverland, 2 sub-formats (SFC/S2C) | Lufia (SFC), Lufia II (S2C) | seq, instr |
| `NinSnes` | Nintendo's N-SPC — the broadest SNES format, 17 dev-team "profiles" driving the same core dialect | Profiles named in source (not individual games): Earlier, Standard, RD1, RD2, HAL, Konami, Lemmings, Intelligent Systems (FE3/"TA"/FE4), Human, TOSE, Quintet ActRaiser, Quintet ActRaiser 2, Quintet Illusion of Gaia, Quintet Terranigma, Falcom Ys IV — i.e. this is the format underlying most first-party Nintendo titles plus a long tail of third-party N-SPC licensees | seq, instr |
| `PandoraBoxSnes` | Pandora Box, 2 versions | V1: Kishin Korinden Oni. V2: Traverse: Starlight and Prairie | seq, instr |
| `PrismSnes` | Prism Kikaku, 3 sub-versions | Cosmo Gang: The Video, Dual Orb, Dual Orb 2 (King of Dragons and "Pieces" noted as close-but-slightly-different) | seq, instr |
| `RareSnes` | Rare | Donkey Kong Country, Killer Instinct, Donkey Kong Country 2 (and 3), Ken Griffey Jr. Winning Run | seq, instr |
| `SoftCreatSnes` | Software Creations, 5 versions | V1: Spider-Man and the X-Men: Arcade's Revenge, Equinox. V2: Plok!. V3: Spider-Man and Venom: Maximum Carnage. V4: The Tick, Ken Griffey Jr. Presents MLB. V5: Tin Star, Foreman for Real | seq only (no instrument reader in this dir) |
| `SuzukiSnes` | SquareSoft's "Suzuki" engine, 3 versions | Seiken Densetsu 3, Bahamut Lagoon, Super Mario RPG (near-identical to Bahamut Lagoon) | seq, instr |

## PlayStation (PS1) formats

| Directory | Driver family | Known games (from source) | Exports |
|---|---|---|---|
| `Akao` | SquareSoft's PS1-era AKAO format (distinct codebase from `AkaoSnes`, versioned via `AkaoPs1Version`) | not individually named in source; README credits community research into "PS1 AKAO format" broadly (Square's late-90s PS1 catalog) | seq, instr, sample; has its own `AkaoColl` collection class |
| `FFT` | SquareSoft's `smds`/`wds` format | Final Fantasy Tactics (per README; directory name and scanner both name it explicitly) | seq, instr |
| `HeartBeatPS1` | Heartbeat's PS1 `.seqq`-family format | Dragon Quest (per README: "used in Dragon Quest games") | seq (no dedicated instr reader in this dir — see `FilegroupMatcher` pairing) |
| `HOSA` | "HOSAV"-signature PS1 format | not named in source; README credits an anonymous early contributor ("Sound Test: 774") for this format and for analyzing `TriAcePS1` | seq, instr (reuses shared `PSXSPU` sample scanning) |
| `KonamiPS1` | Konami's KDT1 sequence format (ported from the external `kdt-tool` project, credited in README) | not named in source | seq only |
| `PS1` | Sony's own generic PS1 format — `.seq` sequences + `.vab` instrument banks (`Vab.cpp`/`Vab.h`) | not named in source; this is the generic/first-party Sony driver, the broadest PS1 format by file count | seq, instr (VAB) |
| `TamSoftPS1` | Tamsoft's `.tsq`/`.tvb` format | not named in source | seq, instr |
| `TriAcePS1` | Tri-Ace's SLZ-compressed sequence format (SLZ v0–v3) | scanner comment: "SLZ v2 is used by a few tracks in Valkyrie Profile" | seq, instr |

## PlayStation 2 formats

| Directory | Driver family | Known games (from source) | Exports |
|---|---|---|---|
| `SonyPS2` | Sony's first-party PS2 driver, detected via `SCEI`/`Vers` chunk signature, `.sq`/`.hd`/`.bd` | not named in source | seq, instr; has its own `SonyPS2Coll` collection class |
| `SquarePS2` | Square's PS2 driver — `.bgm` sequences + `.wd` wave-data sets (`WD.cpp`/`WD.h`) | not named in source | seq, instr (WD) |

## Sega Saturn formats

| Directory | Driver family | Known games (from source) | Exports |
|---|---|---|---|
| `SegSat` | Sega's own Saturn sequence/instrument format, detected from `.ssf`/`.minissf`/`.ssflib` PSF-family containers | not named in source | seq, instr; uses collection-based seq conversion |

## Arcade formats

| Directory | Driver family | Known games (from source) | Exports |
|---|---|---|---|
| `CPS` | Capcom CPS-1 (OKIM6295) / CPS-2 (QSound) / CPS-3, loaded via MAME ROM-set zips (`MAMELoader.h`) | version strings only (e.g. `CPS1_V1.00`..`CPS1_V5.02`, `CPS2_V1.00`..); README: "used in CPS-1/CPS-2/CPS-3 titles" broadly | seq, instr; two sub-formats `CPS1Seq`/`CPS2Seq` in one directory |
| `KonamiArcade` | Konami arcade hardware, 2 hardware families ("MysticWarrior" Z80, "GX" MC68000/K054539) | Mystic Warriors (Z80 NMI-rate byte pattern), Salamander 2 (MC68000/K054539 byte patterns) — named directly in scanner byte-pattern comments | seq, instr |
| `KonamiTMNT2` | Konami's TMNT2-era arcade sound driver, 4 named hardware/game variants | `tmnt2`, `ssriders` (Sunset Riders), `vendetta`, `xexex` — named in the version-string map | seq, instr (plus a dedicated OPM instrument variant and a "Vendetta" instrument variant) |

## Game Boy Advance

| Directory | Driver family | Known games (from source) | Exports |
|---|---|---|---|
| `MP2k` | Nintendo's MusicPlayer2000 ("Sappy") driver — ported from Bregalad's GBAMusRipper research (credited in both the file header and README) | not enumerated (Sappy is used industry-wide across a large fraction of the GBA library, not a single-studio format); supports `gba`/`gsf`/`minigsf`/`gsflib` containers | seq, instr |

## Nintendo DS

| Directory | Driver family | Known games (from source) | Exports |
|---|---|---|---|
| `NDS` | Nintendo's SDAT container format; supports `nds`/`sdat`/`2sf`/`mini2sf`/`2sflib` containers | not named in source (SDAT is Nintendo's standard first-party NDS sound format, not studio-specific) | seq, instr |

## Non-console format

| Directory | Driver family | Known games (from source) | Exports |
|---|---|---|---|
| `Org` | Cave Story's `Org-02` format (`.org`), detected by the literal `"Org-02"` signature | Cave Story (Doukutsu Monogatari) — a PC/DOS freeware title, not a console game; the one format in this catalog that isn't console-scoped | seq only |

## Directory count

38 directories under `src/main/formats/`: 37 distinct format families
(one, `CPS`, covers two related sub-formats — CPS1 and CPS2 — in a single
directory) plus `common/` (shared base classes, not a format itself).

## Breadth summary

SNES is by far the best-covered console (18 driver families), reflecting
how fragmented SNES sound-driver authorship was — nearly every
studio/publisher wrote or licensed its own engine, and VGMTrans has readers
for the popular ones (Square's AKAO/Suzuki, Nintendo's N-SPC across 17
sub-profiles, Rare, Konami, Capcom, Hudson, Compile, and a long tail of
smaller studios). PS1 has solid but narrower coverage (8 formats — Sony's
own generic seq/VAB driver, Square's AKAO and FFT-specific formats, and
several third/second-party engines from Heartbeat, Konami, Tamsoft, and
Tri-Ace); PS2 and Sega Saturn coverage is thin (2 and 1 formats,
respectively — Sony and Square on PS2, Sega's own driver on Saturn). Arcade
coverage is narrow but deep on Capcom (CPS-1/2/3) and Konami (two separate
driver eras). GBA (MP2k/Sappy) and Nintendo DS (SDAT) each have one format,
but both are the platform's dominant first-party standard rather than one
game's bespoke driver, so in practice they cover a large share of each
platform's library. One entry, `Org` (Cave Story), isn't console-scoped at
all — a reminder this catalog is "whatever VGMTrans's contributors have
reverse-engineered," not a console-by-console completeness guarantee.

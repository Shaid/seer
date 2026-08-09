# MS-DOS Static Recompilation Landscape

A survey of native-code static reconstruction for MS-DOS x86 real-mode games,
contrasted with emulation and source decompilation. Companion docs:
[`amiga-recomp.md`](./amiga-recomp.md), [`megadrive-recomp.md`](./megadrive-recomp.md),
[`snes-recomp.md`](./snes-recomp.md), [`engine-based-porting.md`](./engine-based-porting.md).

DOS earns a doc in this series because it is a platform this project's corpora
actually target — Black Crypt's VGA port, *War in Middle Earth*'s DOS VGA and
DOS EGA releases, *Warriors of Legend* (DOS-only) — and because, unusually for
this series, **the prior art here is better than a topic scan suggests.**

## 1. The CPU is not the problem; the platform boundary is

x86 real-mode is the best-understood ISA on the planet, and unlike the
platforms in this series with awkward coprocessors (PS3's SPUs, PS2's VUs,
N64's RSP, the Amiga's Copper and Blitter), a DOS game's behaviour is almost
entirely scalar CPU code plus two well-documented interfaces:

- **DOS itself** — `INT 21h` and friends. A thin, fully documented API surface
  (file I/O, memory allocation, program termination) that maps cleanly onto host
  equivalents. Nothing here needs cycle accuracy.
- **The PC hardware** — VGA register and framebuffer access (`0xA0000`, the
  Sequencer/CRTC/attribute registers, Mode X planar writes), the PIT, the PIC,
  the keyboard controller, Sound Blaster/Adlib ports. Wider than the DOS API,
  but static and documented.

The genuinely hard cases are the ones that abuse timing the way an Amiga game
abuses the beam: PIT-driven per-scanline palette effects, code that measures CPU
speed by counting loop iterations, and self-modifying code. Those are a minority
of a DOS title's behaviour, where on the Amiga chipset interaction *is* the
behaviour ([`amiga-recomp.md`](./amiga-recomp.md) §2). Structurally, DOS should
be **more tractable than every other platform in this series**.

## 2. Prior art: one real, substantial project

**[M-HT/SR](https://github.com/M-HT/SR)** — 405★, 312 commits, actively
maintained — is a genuine static recompiler for DOS games, and it has shipped
playable native ports of four commercial titles:

| Game | Original |
|---|---|
| Albion | Blue Byte, 1995 |
| X-COM: UFO Defense (UFO: Enemy Unknown) | MicroProse, 1994 |
| X-COM: Terror from the Deep | MicroProse, 1995 |
| Warcraft: Orcs & Humans | Blizzard, 1994 |

Its sibling **SRW** does the same for two Windows titles (Septerra Core, Battle
Isle 3).

**Technique.** SR consumes the original executable plus a hand-authored
description of it, and emits intermediate assembler — `x86`, `arm`, `x64`, or its
own `llasm` form. `llasm` is then lowered to LLVM IR and compiled to native code.
Output binaries run on Windows (x86/x64), Linux (x86/x64/ARM/ARM64/RISC-V 64) and
macOS (x64/ARM64), with both softfp and hardfp ARM calling conventions. That
target breadth is itself evidence the lifting is real rather than a
thin x86-to-x86 rewrite.

**Per-game manual work is the honest cost.** The project is structured as
`SR-games` (per-title descriptions of the original executables), plus a `games`
subproject holding game-specific hand-written source, plus optional plugins for
better music playback and image enhancement. This is the same shape as every
other success in this series: a general engine, but a per-title human
investment that doesn't amortise across the back catalogue.

**Not in the topic index.** GitHub's
[`static-recompilation` topic](https://github.com/topics/static-recompilation)
lists ~42 repositories — PS2, Xbox 360, N64, GameCube, Switch, NES, 32X, Neo
Geo, CHIP-8 — and **contains no DOS entry at all**, nor any Amiga/68k entry.
SR is absent from it. A survey that scans only that topic (as several docs in
this series partly do) will wrongly conclude DOS is unstarted. It isn't; it just
isn't tagged.

## 3. The incumbent: DOSBox, and why it suppresses demand

DOSBox and DOSBox-X are the reason this field is small rather than the reason
it's hard. They are mature, ubiquitous, run essentially the entire DOS back
catalogue, and are the delivery mechanism GOG and Steam use to ship DOS games
commercially today. The performance argument that motivates recompilation on
PS3 or PS2 barely exists here: a 1994 DOS game emulated on modern hardware has
enormous headroom.

This is the same dynamic [`wiiu-recomp.md`](./wiiu-recomp.md) identifies for
Cemu — a dominant emulator that already delivers what recompilation promises
removes most of the incentive. The difference is that on DOS, someone built the
recompiler anyway.

## 4. Honest maturity assessment

DOS sits **ahead of Amiga, Saturn, Wii U and 3DS, and behind GameCube/Wii, GBA
and PS2** in this series. It has:

- a real, maintained, general-purpose static recompiler (SR),
- four shipped commercial-game ports proving the pipeline end to end,
- the most tractable technical substrate of any platform surveyed, and
- an LLVM-based backend giving genuinely portable output.

What it lacks is a scene. SR appears to be substantially one developer's work,
there is no ecosystem of tooling around it comparable to the `pret` decompilation
scene on GBA or `decomp-toolkit`/`objdiff` on GameCube, and no second project
independently attacking the same problem. The technique is demonstrated; the
community is not there.

**For this project specifically:** if a DOS-port native reconstruction ever
becomes a goal, SR is the starting point and its `SR-games` per-title
descriptions are the format to study — not a from-scratch lifter. The realistic
near-term value is lower and more certain: SR's per-game executable descriptions
are a worked example of documenting a DOS binary's segment and entry-point
structure, which is the same problem `game-re-tooling/dos.md`'s CS/DS
segment-resolution notes address from the analysis side.

---

*Seeded 2026-08 from a survey of `awesome-game-file-format-reversing`; SR's
scope, maturity and technique verified directly against its repository, and the
`static-recompilation` topic's contents checked for DOS and 68k entries.*

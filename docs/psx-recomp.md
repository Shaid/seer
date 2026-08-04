# Static Recompilation Prospects: PlayStation 1 (PSX)

*General ecosystem survey, not tied to any specific game. Companion to `ps2-recomp.md`; see also the project's earlier PS3/`ps3recomp` research for the broader static-recompilation-wave context (N64: Recompiled, sm64ex, etc.).*

## 1. Why PS1 is the easy case

The original PlayStation is, by a wide margin, the most tractable Sony console for static recompilation, almost entirely because of CPU simplicity:

- **CPU**: a single [MIPS R3000A](https://en.wikipedia.org/wiki/R3000) core (~33.8 MHz) — a plain 32-bit MIPS I ISA with a standard branch-delay slot, no superscalar hazards, no SMP, and critically **no cache-coherency problem at all**, since there's only one core and one instruction stream. That's the entire class of problem that makes PS3 (SPU/PPU coherency, LV2 threading) and PS2 (EE + IOP + two VUs running concurrently) hard — on PS1 it simply doesn't exist.
- **Well-documented ISA**: R3000A is one of the best-understood architectures in the retro/decompilation world, partly because close derivatives power the N64's VR4300 lineage. Instruction encoding, calling conventions, and BIOS ABI are exhaustively documented (see [PSX-SPX](https://psx-spx.consoledev.net/), the de facto hardware reference).
- **GTE (COP2)**: the one custom-silicon piece a recompiler must handle is the Geometry Transformation Engine, a fixed-function-ish vector/matrix coprocessor for 3D transform, projection, lighting, and depth-cue math, accessed via ordinary MIPS coprocessor instructions (`LWC2`/`SWC2`/`COP2`) and documented opcodes (`RTPS`, `NCLIP`, `AVSZ3`, etc. — see [RetroReversing's GTE overview](https://frds.github.io/ps1-gte)). Because it's a small, fixed, well-specified instruction set rather than a programmable core, it's already been cleanly reimplemented, repeatedly and independently, inside PS1 emulators: Mednafen/[Beetle PSX](https://www.libretro.com/index.php/mednafenbeetle-psx-pgxp-arrives/), [DuckStation](https://github.com/stenzek/duckstation), and [PCSX-Redux](https://github.com/grumpycoders/pcsx-redux) all ship independent from-scratch GTE cores, and DuckStation/Beetle-PSX further popularized [PGXP](https://www.libretro.com/index.php/mednafenbeetle-psx-pgxp-arrives/), a high-precision reinterpretation of GTE math that fixes PS1's classic vertex jitter. Unlike PS2's VU1 or PS3's SPUs, the GTE isn't a second CPU running arbitrary microcode — it's closer to a documented fixed-function math unit, which a recompiler (or an HLE stub) can swallow whole.

Net effect: a PS1 recompiler mostly has to solve "translate one simple, well-documented MIPS core plus one small coprocessor," with no concurrency and no runtime-generated vector microcode to worry about — a categorically smaller problem than PS2 or PS3.

## 2. Existing recompilation and decompilation prior art

Two different routes reach the same end goal — a game running natively on PC — and PS1 has real, active work in both.

### Binary-level static recompilers (2026 wave)

A cluster of PS1-specific static recompilers, modeled directly on the N64: Recompiled / Zelda 64: Recompiled playbook, appeared in 2026:

- **[ps1-recomp](https://github.com/PS1Recomp/ps1-recomp)** ("PS1Recomp"/PixyGarden) translates MIPS R3000A code to C++ ahead of time via four components: `ps1Analyzer` (parses the ELF/BIN, finds function boundaries, and identifies PsyQ SDK calls via SHA-256 signature matching against 3,463 signatures from 14 SDK versions), `ps1Recomp` (1:1 literal C++ emission, with a dedicated `gte_emitter` for COP2), `ps1Runtime` (BIOS HLE, OpenGL 3.3 GPU, SDL2 SPU audio, CD-ROM/DMA), and an ImGui inspection GUI. It's an active undergraduate-thesis project with 557 passing tests; demoed results include *Rayman (USA)* at ~59 fps and an experimental, partial *Crash Bandicoot 1* boot. Notably, [Read Only Memo reported](https://readonlymemo.com/ps1-recompiled-progress-recompone-pixygarden-interview/) that "almost half" of its commits are authored by Anthropic's Claude coding agent — a point of community controversy.
- **[RecompOne](https://github.com/BlackLabelHQ/RecompOne)** is a competing, deliberately human-only effort by a solo CS student ("Flaffy"), who told Read Only Memo: *"This project is not vibe-coded. AI was not involved."* It targets C# output (e.g. `addiu` becomes an op against a `CpuContext`), works best paired with an existing source decompilation (its first target, *Symphony of the Night*, leans on `sotn-decomp` below), and requires manual PsyQ function identification for games without one. MIT licensed, actively maintained by a single developer as of mid-2026.
- Earlier/parallel efforts under similar names (`mstan/psxrecomp`, `marinocg/psxrecomp`) pursue the same MIPS-R3000A-to-C-to-native-executable goal with less visible traction.

None of these reliably runs arbitrary PS1 titles unattended — each still needs per-game bring-up (symbol recovery, PsyQ stub coverage, patching non-matching functions), much like N64: Recompiled needed per-game work before Zelda 64: Recompiled became a flagship result.

### Source-level decompilation (the more mature route)

PS1 has a larger, more mature body of *decompilation* work — reverse-engineered C/C++ source that recompiles to match the original binary — built on the [decomp.me](https://decomp.me/) toolchain shared with the N64 scene. Because both are MIPS, tooling crosses over directly: **[splat](https://github.com/ethteck/splat)** (binary splitting; supports N64, PSX, PS2, PSP), decomp.me itself, **m2c**/mips2c (Matt Kempster; reported to outperform Hex-Rays/Ghidra on this ISA), **asm-differ**/**decomp-permuter** (Simon Lindholm), and **maspsx**/**esa** (mkst) are all N64-decomp-born tools PSX projects reuse directly, since PsyQ-era GCC and N64 SDK-era GCC are close cousins.

Named game projects include **[open-spyro](https://github.com/theMagicalKarp/open-spyro)** and an independent second effort ([spyro-1](https://github.com/TheMobyCollective/spyro-1)) for *Spyro the Dragon*; **[mgs_reversing](https://github.com/FoxdieTeam/mgs_reversing)** for *Metal Gear Solid* (main executables reported 100% decompiled, overlays ongoing), plus **mgs_compilation_tools**; **[croc](https://github.com/Xeeynamo/croc)**, decompiling *Croc: Legend of the Gobbos* against a symboled demo build; **[sotn-decomp](https://github.com/Xeeynamo/sotn-decomp)**, a substantial multi-platform decompilation of *Castlevania: Symphony of the Night* (PSX/PSP/Saturn) that RecompOne itself is bootstrapping from; and **[lom-decomp](https://github.com/celophi/lom-decomp)** for *Legend of Mana*.

**[OpenLara](https://github.com/XProger/OpenLara)** deserves an explicit note as the *opposite* method: a clean-room, from-scratch reimplementation of the Tomb Raider 1–5 engine (not reverse-engineered, not byte-matching) that loads original game data files at runtime. It reaches a similar practical outcome — Tomb Raider running natively and portably (down to GBA and 3DO) — through engine rewrite rather than binary/source fidelity, distinct from true decompilations like open-spyro or croc.

This decompilation route achieves static recompilation's end state for a much longer list of individual games, but each is a bespoke, multi-year, game-specific project, not a general tool aimable at an arbitrary PS1 ELF.

## 3. PSn00bSDK and toolchain context

**[PSn00bSDK](https://github.com/Lameguy64/PSn00bSDK)** is a community-built, open-source reimplementation of Sony's PSY-Q SDK — a GCC-MIPS toolchain, CMake build system, and `libpsn00b` runtime libraries (GPU/GTE/SPU/CD-ROM/pad). It isn't a recompilation tool itself, but it's a working, documented reconstruction of the exact ABI and library surface that decompilation/recompilation projects reverse-engineer *against* (e.g. `ps1-recomp`'s PsyQ signature database exists because retail games link the proprietary equivalent), and it shows the PS1 toolchain's conventions are now understood well enough to rebuild openly, not just reverse-engineer piecemeal per game.

## 4. Honest state of play

As of mid-2026, PS1 static recompilation as a *general-purpose, engine-agnostic tool* is **early/experimental but moving fast, and clearly less speculative than PS2 or PS3's equivalents.** Two independently developed recompilers (`ps1-recomp`, RecompOne) already produce partial, running results on real commercial games — further than either PS2 or PS3 static recompilation has gotten on comparable AAA titles — though neither is a drop-in "any ELF in, working build out" tool yet.

By contrast, **PS1 source-level decompilation is genuinely mature** for titles that have projects — Spyro, Metal Gear Solid, Croc, Symphony of the Night, and others sit on the same battle-tested MIPS decomp toolchain that powers N64 decomp: "solved methodology, ongoing execution," not nascent. For a specific well-known title, decompilation remains today's most reliable path to a native PC build; for a general tool spanning arbitrary PS1 binaries without a bespoke multi-year project per game, that's the newer, less proven 2026-era static-recompiler work — promising, not yet turnkey.

### Sources
- [PS1Recomp / ps1-recomp](https://github.com/PS1Recomp/ps1-recomp)
- [RecompOne](https://github.com/BlackLabelHQ/RecompOne)
- [mstan/psxrecomp](https://github.com/mstan/psxrecomp)
- ["Two recompilation projects are tackling the PS1 — but only one's doing it without Claude" — Read Only Memo](https://readonlymemo.com/ps1-recompiled-progress-recompone-pixygarden-interview/)
- ["I Built a PS1 Static Recompiler With No Prior Experience (and Claude Code)"](https://1379.tech/i-built-a-ps1-static-recompiler-with-no-prior-experience-and-claude-code/)
- ["This Project Is Not Vibe-Coded" — Time Extension](https://www.timeextension.com/news/2026/07/this-project-is-not-vibe-coded-ps1-recompilation-tool-recompone-goes-live)
- [open-spyro (Spyro the Dragon decompilation)](https://github.com/theMagicalKarp/open-spyro)
- [TheMobyCollective/spyro-1](https://github.com/TheMobyCollective/spyro-1)
- [FoxdieTeam/mgs_reversing (Metal Gear Solid)](https://github.com/FoxdieTeam/mgs_reversing)
- [g-e-o/mgs_compilation_tools](https://github.com/g-e-o/mgs_compilation_tools)
- [Xeeynamo/croc (Croc: Legend of the Gobbos decompilation)](https://github.com/Xeeynamo/croc)
- [Xeeynamo/sotn-decomp (Castlevania: Symphony of the Night, PSX/PSP/Saturn)](https://github.com/xeeynamo/sotn-decomp)
- [celophi/lom-decomp (Legend of Mana)](https://github.com/celophi/lom-decomp)
- [OpenLara](https://github.com/XProger/OpenLara) / [Tomb Raider (OpenLara) — Libretro Docs](https://docs.libretro.com/library/openlara/)
- [ethteck/splat (binary splitter, N64/PSX/PS2/PSP)](https://github.com/ethteck/splat)
- [decomp.me](https://decomp.me/)
- [PSn00bSDK](https://github.com/Lameguy64/PSn00bSDK)
- [PS1 GTE overview — RetroReversing](https://frds.github.io/ps1-gte)
- [Mednafen/Beetle PSX PGXP announcement — Libretro](https://www.libretro.com/index.php/mednafenbeetle-psx-pgxp-arrives/)
- [DuckStation](https://github.com/stenzek/duckstation)
- [PCSX-Redux](https://github.com/grumpycoders/pcsx-redux)
- ["Decompilation projects and N64 Recompiled PC ports" — Read Only Memo](https://readonlymemo.com/decompilation-projects-and-n64-recompiled-list/)

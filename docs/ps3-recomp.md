# PS3 Static Recompilation — State of the Art

A general survey of static/ahead-of-time recompilation for the PlayStation 3, independent of any specific game. Companion docs: [`psx-recomp.md`](./psx-recomp.md), [`ps2-recomp.md`](./ps2-recomp.md), [`amiga-recomp.md`](./amiga-recomp.md).

## CPU architecture: the Cell Broadband Engine

The PS3's Cell BE is the single biggest reason PS3 recompilation lags behind N64- or even Xbox 360-style efforts. It's a heterogeneous design: one **PPU** (a weak, in-order PowerPC core) plus up to **6 usable SPUs** (Synergistic Processing Units), each with its own 256KB local store and *no unified view of main memory* — SPU programs operate purely on data explicitly DMA'd into their local store, not on addressable global memory the way a normal CPU core does.

That asymmetry is what makes SPU code the hard part of any PS3 recompilation effort. A PPU function is "just" PowerPC — lift it to IR, emit native code, done. An SPU program is a tight, DSP-like SIMD kernel operating on a private 256KB window, frequently DMA-scheduled and sometimes patched/generated at runtime by the PPU side, which complicates ahead-of-time static analysis in a way that has no real analog on N64 (single MIPS core) or, arguably, even on PS2's VU1 (see [`ps2-recomp.md`](./ps2-recomp.md) — similar idea, smaller scale: 1-2 vector units vs. up to 6 SPUs).

**RSX**, the GPU, is comparatively tractable — an NVIDIA G70/GeForce-7800-derivative sharing some lineage with the Xbox 360's Xenos, programmed via a command buffer (GCM). Translating a GCM command stream to a modern API (D3D12/Vulkan) is a well-understood problem class, not a novel one.

## Existing prior art: ps3recomp

Static recompilation prior art for PS3 does exist and is more advanced than a casual guess would suggest: **[ps3recomp](https://github.com/sp00nznet/ps3recomp)** (developer "sp00nznet"/Ned Heller) is an active, open-source project doing genuine ahead-of-time translation — PPU/VMX lifting to C, SPU program extraction (using an image-ID dispatch scheme to handle the fact that different SPU programs can share overlapping local-store addresses at different times), and a working RSX-command-stream-to-D3D12 backend.

As of v0.7.0 (July 2026) it has partial, playable ports of a handful of titles — **flOw**, **You Don't Know Jack**, **Tokyo Jungle**, and **The Simpsons Arcade Game** — with tens of thousands of lifted functions per title, though gaps remain (media codecs still lean on FFmpeg rather than native decode, and SPURS/SPU task-pipeline support is still in progress). The author is explicit that it is **not** a general-purpose "any PS3 game" converter yet — it's pre-1.0 and actively soliciting help porting RPCS3's HLE modules into standalone reusable form. Still, it's real, working, public engineering, which is more than existed even a year or two prior. ([GitHub](https://github.com/sp00nznet/ps3recomp), [coverage](https://www.generationamiga.com/2026/06/15/ps3recomp-the-new-tool-bringing-native-playstation-3-ports-closer-to-pc/))

## RPCS3 as reference implementation

**[RPCS3](https://github.com/RPCS3/rpcs3)**, the dominant PS3 emulator, is essential reading regardless of whether an eventual effort goes static or dynamic — it's the most complete public implementation of "how PS3 code actually executes": PPU/SPU ISA semantics, lv2 kernel syscall/HLE modules (threads, memory, `cellFs`, `sceNp`, etc.), and SELF/NPDRM decryption code paths.

Notably, RPCS3's *default* PPU backend isn't a classic dynamic/tracing JIT — it's an LLVM recompiler that translates whole functions to LLVM IR and caches the compiled result to disk ahead of subsequent runs, which is structurally close to static recompilation already. Its SPU backend has moved the same direction (LLVM-based translation, with the older ASMJIT path now legacy/fallback, chosen historically for SPU because tight SIMD kernels don't need LLVM's full optimizer and low recompile latency mattered more for a live JIT). ([writeup](https://dev.to/fares_haroun_843cfa2d784e/how-rpcs3-emulates-the-ps3-and-why-it-took-a-decade-of-unreasonable-effort-17kk), [RPCS3 PR #6193](https://github.com/RPCS3/rpcs3/pull/6193)) — meaning "we don't want JIT" is a smaller obstacle to reusing RPCS3's understanding than it first sounds; the parts worth mining are the function-boundary/control-flow analysis and per-instruction semantics, not the runtime dispatch loop.

**License note**: RPCS3 is GPLv2. The N64/Xbox-recomp scene hit this exact issue before — Zelda 64: Recompiled and friends deliberately wrote fresh PPC-to-C translators rather than lifting Mupen64Plus's dynarec, since compiled output derived from GPL code arguably inherits the license. Anyone using RPCS3 as an *architecture reference* rather than a code source sidesteps this; vendoring its code directly does not.

## Prerequisite: SELF/NPDRM decryption

Before any PPU/SPU code can even be lifted, it has to be decrypted — PS3 executables ship as SELF (signed+encrypted ELF), a layer entirely separate from any outer PKG container encryption. This is well-trodden, publicly documented territory (see the [PS3 Developer Wiki](https://www.psdevwiki.com/ps3/Main_Page) and fail0verflow's `ps3tools`, still mirrored on GitHub, e.g. [masterzorag/f0f_ps3tools](https://github.com/masterzorag/f0f_ps3tools)), not a research problem — just necessary plumbing before code-level recompilation work can start.

## Honest maturity assessment

PS3 recompilation is **early but real** — a working, actively-developed general framework (`ps3recomp`) exists with several partial playable ports, which is a meaningfully different state than "doesn't exist yet." It sits behind PS2's OpenGOAL/jak-project effort in *polish for its supported titles* (see [`ps2-recomp.md`](./ps2-recomp.md)) but ahead of it in *generality of approach* — OpenGOAL only works because Jak & Daxter's GOAL bytecode is unusually decompilation-friendly, whereas ps3recomp is a genuine binary-level static recompiler intended to eventually generalize across normal C/C++-compiled PS3 titles. It's well ahead of the current PSX general-tooling situation (see [`psx-recomp.md`](./psx-recomp.md)), which remains mostly scattered game-specific decompilation projects rather than one general recompiler. The Cell BE's SPU asymmetry remains the long pole for any given new title, including Drakengard 3 should this project ever pursue that stretch goal.

# Third-Party Licenses

## SNES SPC700/S-DSP emulation (`@seer-project/snes`)

> **Needs a licensing/compliance review before this package is published to
> npm.** This entry records the provenance already present in the source
> code's own doc comments; it is not a legal determination that the
> arrangement below is compliant. In particular: `@seer-project/snes` is
> distributed under AGPL-3.0-or-later, while the two sources below are
> LGPL-2.1 and GPL-3 respectively — get this checked by someone qualified
> before shipping a published release.

The `@seer-project/snes` package's `spc700-cpu.ts` is ported from
**blargg's `snes_spc`** (`SPC_CPU.h`), licensed under the **GNU Lesser
General Public License, version 2.1**. `spc700-dsp.ts`'s noise generator
(`NON`) is likewise ported from `snes_spc`'s `SPC_DSP.cpp`.

Several modules (`spc700-cpu.ts`, `spc700-dsp.ts`, `envelope.ts`, `echo.ts`,
`brr.ts`) are cross-checked against, and in places transcribed from,
**Mesen2**'s SNES core (`Core/SNES/Spc.Instructions.cpp`,
`Core/SNES/DSP/Dsp.cpp`, `Core/SNES/DSP/DspVoice.cpp`), licensed under the
**GNU General Public License, version 3**.

Neither upstream project's license text is reproduced in full here yet —
add it (and the copyright notices from each project's own `LICENSE`/
`license.txt`) before publishing.

## Tegra X1 block-linear swizzle (`@seer-project/gpu-textures`)

> **Needs a licensing/compliance review before this package is published to
> npm.** As with the SNES entry above, this records the provenance already
> present in the source's own doc comment; it is not a legal determination.

`@seer-project/gpu-textures`'s `swizzle.ts` (the Tegra X1/Nintendo Switch
block-linear (de)swizzle address computation) is, per its own doc comment,
"ported from the astral-extractor reference (which itself derives from
Ryujinx / aboood40091's BNTX-Extractor)." No LICENSE file or explicit
license grant from either upstream project has been located in this
repository's history. Get the actual license terms of astral-extractor and
BNTX-Extractor (and, transitively, Ryujinx's own license at the time that
code was written) confirmed before shipping a published release under
`@seer-project/gpu-textures`'s AGPL-3.0-or-later license.

`bc.ts`'s BC7 decoder (mode table, partition/fixup/weight tables, and the
bitstream decode logic) is ported field-for-field from Microsoft's
DirectXTex reference decoder (`D3DX_BC7::Decode()`,
`DirectXTex/BC6HBC7.cpp`), which is MIT-licensed
(https://github.com/microsoft/DirectXTex) — this is lower-risk than the
swizzle provenance above (MIT is broadly compatible with redistribution
under AGPL-3.0-or-later), but the upstream MIT license text/copyright
notice is not yet reproduced here; add it before publishing.

## MAME arcade chip/video emulation (`@seer-project/arcade`)

> **Needs a licensing/compliance review before this package is published to
> npm.** As with the entries above, this records the provenance already
> present in the source's own doc comments; it is not a legal determination.

Several `@seer-project/arcade` modules are direct/field-for-field ports of
real MAME device or video emulation source, per their own doc-comment
provenance: `capcom/oki-adpcm.ts` (MAME's `okiadpcm.h`/`.cpp`),
`sega/upd7759-adpcm.ts` (MAME's `upd7759.cpp`), `capcom/qsound.ts` /
`capcom/qsound-driver.ts` (MAME's `qsound.cpp`), and `sega/system16-gfx.ts`
(MAME's `segaic16.cpp`/`resnet.cpp`). `capcom/sh2.ts` (an existing module,
ported from the FBNeo SH-2 interpreter, itself MAME-derived) is an
already-unrecorded precedent of the same kind. MAME is licensed under the
**BSD 3-Clause License** for its own-authored device/video cores (some MAME
drivers carry additional restrictions, but the specific files above are
standard BSD-3 device emulation, per MAME's own licensing documentation at
the time these ports were made). Neither MAME's license text nor its
copyright notice is reproduced in full here yet — add them, and confirm
which MAME contributors' copyright applies to each specific file, before
publishing `@seer-project/arcade` under its AGPL-3.0-or-later license.

## CRI Middleware CPK/CRILAYLA (`@seer-project/cri`)

> **Needs a licensing/compliance review before this package is published to
> npm.** As with the entries above, this records the provenance already
> present in the source's own doc comments; it is not a legal determination.

`@seer-project/cri`'s `cpk.ts` — specifically `decompressCrilayla`, the
CRILAYLA compression scheme used inside CRI Middleware's CPK archives — is
ported from the community **CriPakTools** reference implementation
(`github.com/esperknight/CriPakTools`). Unlike the other entries in this
file, CriPakTools itself has **no LICENSE file**, and its own README traces
the code's authorship to unlicensed Xentax-forum posts (originally by
"Falo", later modified by "Nanashi3") rather than to any single rights
holder who could grant a license. This provenance is murkier than the
SNES/MAME/DirectXTex entries above, which at least have a clear upstream
license to cite — get this specifically checked by someone qualified before
any published release, since there may be no clean way to satisfy a
license condition that was never actually granted.

## Nintendo 3DS asset formats (`@seer-project/3ds`)

> **Needs a licensing/compliance review before this package is published to
> npm.** As with the entries above, this records the provenance already
> present in the source's own doc comments; it is not a legal determination.

`@seer-project/3ds`'s `ctpk.ts`, `ctr-texture.ts`, and `lz.ts` are, per
their own doc comments, ported from **SciresM/FEAT's `ctpktool`** and a
**DSDecmp** reference implementation (for the Nintendo LZ10/LZ11/LZ13
decompression schemes). `bch.ts` and `cgfx.ts` explicitly state they are
"ported from Ohana3DS-Rebirth's `Models/BCH.cs`/`Models/CGFX.cs`
(gdkchan)." None of these upstream projects' license texts or copyright
notices are reproduced here yet — confirm each project's actual license
(and compatibility with `@seer-project/3ds`'s AGPL-3.0-or-later) before
publishing. `bcstm.ts`, `le.ts`, `container.ts`, and `crypto.ts` do not cite
a specific ported implementation in their doc comments (the AES key-scramble/
ticket logic in `crypto.ts` is standard published 3DS crypto, documented by
projects like Citra/pyctr, not itself a copied implementation) and likely
don't need the same flag — but this hasn't been independently confirmed.

## Micromod JavaScript ProTracker Replay

The `@seer-project/tracker` package contains a TypeScript ESM port of the
Micromod JavaScript ProTracker replay engine by Martin Cameron
(`mumart@gmail.com`). The upstream code is distributed under the BSD
3-Clause License:

Copyright (c) 2019, Martin Cameron
All rights reserved.

Redistribution and use in source and binary forms, with or
without modification, are permitted provided that the
following conditions are met:

* Redistributions of source code must retain the above
  copyright notice, this list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above
  copyright notice, this list of conditions and the following disclaimer
  in the documentation and/or other materials provided with the
  distribution.

* Neither the name of the organization nor the names of
  its contributors may be used to endorse or promote products derived
  from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR
BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

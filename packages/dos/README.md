# @seer-project/dos

DOS executable-compression decoders: Microsoft **EXEPACK** and Haruhiko
Okumura's **LZHUF**.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Optional — install only if your target ships EXEPACK-compressed `.EXE`
files or LZHUF-compressed archives. Both decoders are browser-safe: pure
`Uint8Array` in, `Uint8Array` out, no `Buffer`/`node:` usage.

## Installation

```bash
npm install @seer-project/dos
```

## EXEPACK

```ts
import { unpackExepack, ExepackError } from '@seer-project/dos';

const { image, info } = unpackExepack(exeBytes);
// image: the real, flat load image DOS would have at loadSegment:0000
// info.relocs: flat image-offset targets of every relocation entry
```

Unpacks a DOS MZ executable's real load image from its EXEPACK-compressed
on-disk form. EXEPACK is Microsoft's own compressor, shipped with
`LINK.EXE`/`EXEPACK.EXE`: a pure run-length/verbatim-block scheme
decompressed in place, back-to-front, with a 16-byte header carrying the
ASCII signature `"RB"` and an appended relocation table. Every byte offset
in the *packed* file is meaningless as a code/data address — disassembling
or byte-searching the packed bytes will not locate real code; unpack first.
`unpackExepack` throws `ExepackError` if any of its structural
self-checks fail (see `exepack.ts`'s doc comment for the full list).

## LZHUF

```ts
import { lzhufDecompress } from '@seer-project/dos';

const out = lzhufDecompress(compressed, knownDecompressedSize);
// or, when the decompressed size isn't recorded anywhere:
const out2 = lzhufDecompress(compressed); // decodes until input is exhausted
```

Decompresses one independent Okumura LZHUF stream: LZSS over a 4096-byte
sliding window with an adaptive (dynamic-tree) Huffman model for literals
and match lengths, plus a static prefix table for match-distance upper
bits. This module is purely the codec — a fresh model and ring buffer per
call. Container/archive framing around LZHUF streams (multi-entry
directories, per-entry sizes, etc.) is specific to whatever format uses it
and is not part of this package.

## EXEPACK/LZHUF vs. LZEXE

`@seer-project/pipeline`'s `decompressLZEXE` solves a similar-looking
problem — shrinking a DOS self-extracting `.EXE` — but it is a different
compressor with no shared code: **LZEXE** is a third-party tool using real
LZSS back-reference compression (an LZ77-style sliding-window bitstream,
algorithmically closer to this package's LZHUF than to EXEPACK) plus its
own compressed/delta-encoded relocation table, decompressed via an
`unlzexe.c`-style port. **EXEPACK**, by contrast, is Microsoft's own
scheme: pure run/verbatim RLE blocks, no back-references, decompressed
in-place, with a distinct `"RB"`-signature header. Different vendor,
different algorithm, different header signature — check a file's actual
header before assuming which of the two applies.

## License

AGPL-3.0-or-later

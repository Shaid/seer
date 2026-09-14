# @seer-project/cri

Readers for **CRI Middleware** formats: CRI's CPK archive container, ADX
4-bit ADPCM audio codec, and the ACB/AWB sound-bank containers. CRI
Middleware ships across many Japanese-developed titles (PS2/PS3/PSP/Switch
and others, Sega and others) — these are generic, well-documented
middleware formats, not specific to any one game.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Optional — install only if your target ships CRI Middleware (CPK/ADX/ACB/
AWB) data. Every decoder is browser-safe: pure `Uint8Array`/`DataView` in,
`Uint8Array`/plain data out — no `Buffer`/`node:` usage.

## Installation

```bash
npm install @seer-project/cri
```

## CPK + the `@UTF` table engine

```ts
import { readCpkHeader, readCpkFileTable, decompressCrilayla } from '@seer-project/cri';

const header = readCpkHeader(cpkBytes);
const { entries } = readCpkFileTable(cpkBytes, header);
// entries: { dirName, fileName, fileSize, extractSize, fileOffset, id }[]

const stored = cpkBytes.subarray(entry.fileOffset, entry.fileOffset + entry.fileSize);
const raw = entry.fileSize !== entry.extractSize ? decompressCrilayla(stored) : stored;
```

A CPK's header and TOC are themselves CRI `@UTF` table packets — a generic,
self-describing binary table format (typed columns, per-row or
constant-storage values, nested string/data-blob sections) that CRI reuses
across CPK, ACB, and AWB. The engine (`parseUtf`, `readUtfRow`,
`subUtfTable`, `UtfTable`/`UtfColumn`/`UtfRow`) is exported directly, since
`acb.ts`/`awb.ts` build on it and a consumer parsing an unfamiliar `@UTF`
table (e.g. one of CPK's own ITOC/ETOC ancillary tables) can reuse it too.

`@UTF` packets may be stored DecryptUTF-encrypted (a byte-stream XOR against
a fixed LCG) or already plaintext — `utfPacket`/`decryptUtf` auto-detect and
handle both; `readCpkHeader`/`readCpkFileTable` call them internally.

**CRILAYLA** is CRI's own back-reference compression scheme used for
individual CPK file payloads (`"CRILAYLA"` 8-byte magic). `decompressCrilayla`
is ported from the community [CriPakTools](https://github.com/esperknight/CriPakTools)
reference implementation (`DecompressCRILAYLA`) — see that function's own
doc comment for the bit-stream format (a backward-reading LZ77 variant with
a variable-length-encoded match length).

## ADX

```ts
import { decodeAdx, interleaveChannels } from '@seer-project/cri';

const decoded = decodeAdx(adxBytes); // { sampleRate, channelCount, sampleCount, channelData: Int16Array[] }
const pcm = interleaveChannels(decoded.channelData, decoded.sampleCount);
```

CRI ADX is a 4-bit ADPCM codec with a 2-tap IIR predictor whose coefficients
are derived from a per-stream highpass-cutoff header field. Only standard
(unencrypted, encoding type 3) ADX is decoded; encrypted (KEYCODE) ADX and
the AHX family (encoding types 4/5) throw. See `adx.ts`'s own doc comment
for the full header/block layout and the coefficient-derivation formula.

## AWB (Atom Wave Bank)

```ts
import { parseAwb } from '@seer-project/cri';

const awb = parseAwb(awbBytes); // { format: 'afs2' | 'itoc-cpk', entries: { id, offset, size }[] } | null
```

Two structurally distinct sub-formats are auto-detected: the classic
**AFS2** layout (`AFS2` magic, flat id table, then offset table), and a
**nested-CPK/ITOC** shape where the `.awb` file is itself a complete mini
CPK container using CRI's ITOC (id-indexed table-of-contents) TOC variant.
Both resolve to the same `{id, offset, size}` shape (byte ranges relative to
the AWB's own start) — decoding the audio payload itself (HCA, ATRAC3, ...)
is out of scope.

## ACB (Atom Cue Bank)

```ts
import { parseAcb, parseEmbeddedAwb, resolveAcbAwbOffsets } from '@seer-project/cri';

const acb = parseAcb(acbBytes); // { cueCount, waveformCount, tracks, embeddedAwb? }
const awb = acb.embeddedAwb ? parseEmbeddedAwb(acbBytes, acb.embeddedAwb) : parseAwb(externalAwbBytes);
const resolved = resolveAcbAwbOffsets(acb.tracks, awb!); // adds { awbOffset, awbLength } per track
```

An ACB is itself one `@UTF` table whose row holds a large flat set of
columns, several of which are nested `@UTF` sub-tables (`WaveformTable`,
`CueNameTable`, etc.) stored as data-blob columns. `parseAcb` resolves cue
names against waveform metadata using **positional pairing**
(`CueNameTable` row *N* paired with `WaveformTable` row *N*), which holds
for simple music/cue banks with no per-cue variation; when the counts
diverge, every waveform is still listed (full coverage) but named
generically (`waveform_<id>`) rather than guessed. The full CRI cue graph
(`CueTable`/`SynthTable`/`SequenceTable` bytecode chaining, for
randomized/multi-layer cues) is not implemented as a general interpreter —
see `acb.ts`'s own doc comment for the evidence behind this scope
boundary.

`WaveformTable.EncodeType` is mapped to a codec name via a small confirmed
table (currently `2` → `'hca'`, `8` → `'atrac3'`); an unconfirmed value
reports `unknown-<n>` rather than guessing. Neither codec is decoded by
this package — only structural metadata (channel count, sample rate,
sample count, duration) is available for them.

## License

AGPL-3.0-or-later

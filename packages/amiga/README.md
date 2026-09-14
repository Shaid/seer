# @seer-project/amiga

AmigaOS binary-format parsing — HUNK executables and relocatable modules.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Optional — install only if your target ships Amiga loadfiles. One shared
parser replaces the per-repo HUNK-walking copies that used to live in each
consuming project (see `docs/common-tooling-candidates.md` §9 in the seer
workspace).

## Installation

```bash
npm install @seer-project/amiga
```

## Usage

```ts
import { isHunkFile, parseHunkFile, codeHunks } from '@seer-project/amiga';

if (isHunkFile(data)) {
  const hunks = parseHunkFile(data);
  for (const h of hunks) {
    // h.type ('CODE' | 'DATA' | 'BSS'), h.size, h.memSize, h.fileOffset,
    // h.relocs (decoded HUNK_RELOC32), h.symbols (decoded HUNK_SYMBOL)
  }
  const code = codeHunks(hunks);
}
```

Not a linker/loader: relocations are decoded but never applied, and
`HUNK_DEBUG` is skipped. The parser masks `& 0x3FFFFFFF` on both the header
size table and the in-stream type tag — linkers embed `MEMF_CHIP`/
`MEMF_FAST` flags in both places, and real games do ship such binaries.
Unrecognised hunk types throw with the offending tag and offset rather than
silently truncating the hunk list.

`buildHunkExe(specs)` constructs a synthetic loadseg()-able executable from
a hunk spec list — meant for tests that need known CODE/DATA/BSS layouts,
relocations and symbols without committing binary fixtures.

`resolveHunkRelativeGlobal(hunks, data, value)` resolves a bare 32-bit
"absolute address" literal found in a disassembly (e.g. `move.l
#$18344,d0`) to the real hunk/file-offset it's actually relative to, when
that value is only meaningful pre-relocation — the loader patches such
operands to `targetHunk.runtimeBase + storedValue` at load time, so no
static parse can know the true runtime address. Each candidate result
carries a `corroboratingSites` count: how many other `HUNK_RELOC32` entries
in the file store that exact value as a pointer into the candidate hunk. A
value with zero corroborating sites across every hunk is decisive evidence
it's not relative to any hunk in this file at all.

## Disk images

```ts
import { adfBootblockType, listAdf, readAdfFile } from '@seer-project/amiga';

adfBootblockType(img); // 'OFS' | 'FFS' | 'OFS-INTL' | … | 'KICK' | 'NDOS'
const entries = listAdf(img); // null when not a walkable AmigaDOS disk
for (const e of entries ?? []) {
  if (e.type === 'file') readAdfFile(img, e);
}
```

Read-only OFS/FFS reader for DD (880 KB) and HD (1.76 MB) ADFs. `listAdf`
returns `null` rather than guessing when the image is a RawDIC /
trackloader dump — including the common case of a game that keeps a
valid `DOS` bootblock but stores tracks in a custom layout. Checksums are
not verified (recon reads damaged disks on purpose); bad pointers are
caught by bounds checks, and hash-chain loops terminate.

File sizes are clamped to the image's own length, because a file cannot
be larger than the disk holding it. Corrupt or non-DOS header blocks
yield byte-size fields near 2^32, and sizing an allocation from one
means reserving gigabytes for an 880 KB floppy — a real failure seen on
a collection containing damaged disks.

## LHA archives

```ts
import { isLhaFile, listLha, readLhaEntry } from '@seer-project/amiga';

for (const entry of listLha(data)) {
  if (!entry.isDirectory) readLhaEntry(data, entry); // Uint8Array
}
```

Reads header levels 0, 1 and 2 and decodes `-lh0-`/`-lhd-` (stored) plus
`-lh4-`/`-lh5-`/`-lh6-`/`-lh7-` (LZSS + static Huffman) — the format
essentially all Amiga software is distributed in. Validated byte-for-byte
against the reference extractor across thousands of real members.
Unsupported methods (`-lh1-` and the LZarc-era ones) throw rather than
return wrong bytes, and a damaged archive yields the members preceding
the damage instead of failing entirely.

## WHDLoad slaves

```ts
import { parseWhdloadSlave } from '@seer-project/amiga';

const slave = parseWhdloadSlave(data);
// { version: 17, name: 'Shadow Of The Beast', copy: '1989 Psygnosis', … }
```

Parses the `WHDLOADS` structure at the start of a slave's first CODE
hunk. From v10 the name/copyright/info strings are present, which makes
this the one reliably machine-readable game label in a WHDLoad install.

## License

AGPL-3.0-or-later

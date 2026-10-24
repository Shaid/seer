# @seer-project/switch

Nintendo Switch **container** primitives: getting from a title you own to
bytes you can parse. Three formats, all of them public and none of them
game-specific.

```ts
import { parsePfs0, parseTicket, buildNsoImage, readCString } from '@seer-project/switch';
import { listPfs0File, extractFileRange } from '@seer-project/switch/node';
```

| what | where | shape |
|---|---|---|
| PFS0 partition table (an NSP's layout, and an NCA's ExeFS) | `parsePfs0` | `Uint8Array` -> `{ name, absOffset, size }[]` |
| Retail ticket (`.tik`) | `parseTicket` | `Uint8Array` -> `{ rightsId, rawTitlekeyHex }` |
| `NSO0` executable | `buildNsoImage` | `Uint8Array` -> flat image indexed by the module's own virtual addresses |
| NSP on disk, without reading it | `listPfs0File`, `extractFileRange` (`/node`) | paths and byte ranges |

The LZ4 block codec NSO segments use is **not** here — it is
`@seer-project/core`'s `decompressLz4Block`, because nothing about it is
Switch-specific.

## Offsets are made absolute, on purpose

A PFS0 entry's stored offset is relative to the partition's data base
(`0x10 + entryCount * 0x18 + stringTableSize`). `parsePfs0` adds that base
and calls the result `absOffset`, because treating the stored value as a
file offset carves the wrong bytes out of a multi-gigabyte NSP and produces
no error at all — just an NCA that fails to decrypt for no visible reason.

Likewise `buildNsoImage` lays all three segments out at their
`memoryOffset`s in one buffer, so a pointer read out of the module's own
tables indexes the returned image directly, with no per-segment arithmetic
at the call site.

## No keys, ever

There is no key derivation here, no AES, no keyset parser, and no path to
one. `parseTicket` returns the title key **raw** — still titlekek-encrypted
— because the consumer that decrypts the NCA does the final unwrap itself,
keyed off the *NCA header's* Master Key Revision, which really does disagree
with the ticket's own revision byte in the wild. Unwrapping first makes the
consumer unwrap twice and silently corrupt the section.

Driving a decryption tool (`hactool` and friends) is left to the consuming
project: the binary's location, the user's keyset path and the retry
policies around them are all project-level, and a framework package has no
business hardcoding any of them.

## Scope

- PFS0 only. XCI's HFS0 is the same idea with a 0x40 entry stride and a
  per-entry hash; not implemented.
- NSO header and segments. The MOD0 / dynamic-section layer above it is not
  parsed.
- Ticket layout, not ticket *verification* — the signature block is sized
  and skipped, never checked.

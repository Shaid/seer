# @seer-project/iff

IFF-85 (Interchange File Format) parser.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Optional — install only if your target game uses IFF containers. IFF is a
well-documented container format (EA IFF-85) used widely on the Amiga and
by several cross-platform tools of the era. This parser is generic and
reusable for any IFF-derived format: 8SVX, ILBM, ANIM, SMUS, or custom
FORM-based formats.

## Installation

```bash
npm install @seer-project/iff
```

Depends on `@seer-project/core` (for `BinaryReader`).

## Usage

```ts
import { parseIff, findChunk, findChunks } from '@seer-project/iff';

const form = parseIff(buffer);
if (!form) throw new Error('Not a valid IFF file');

console.log(form.type); // e.g. "SMUS", "8SVX", "ILBM"

// Find a single chunk
const header = findChunk(form, 'SHDR');

// Find all chunks with a given ID
const tracks = findChunks(form, 'TRAK');
```

## Format overview

IFF structure:

```
FORM <size:uint32> <type:FourCC>
  <chunkId:FourCC> <chunkSize:uint32> <data:bytes> [pad byte if odd]
  ...
```

Chunks are padded to even byte boundaries. The parser handles this
automatically.

## Types

| Type | Description |
| --- | --- |
| `IffForm` | `{ type: string; chunks: IffChunk[] }` |
| `IffChunk` | `{ id: string; size: number; data: Uint8Array }` |

## API

| Function | Signature | Description |
| --- | --- | --- |
| `parseIff` | `(buffer: ArrayBuffer) => IffForm \| null` | Parse an IFF FORM from a buffer. Returns `null` if not valid. |
| `findChunk` | `(form, id) => IffChunk \| undefined` | Find the first chunk with a given ID |
| `findChunks` | `(form, id) => IffChunk[]` | Find all chunks with a given ID |

## Testing

```bash
npm test
npm run lint
```

## Licensing & Commercial Use

Seer exists to reverse-engineer other people's work, and that is only possible
because the preservation and romhacking communities published what they found
instead of keeping it. The licence is chosen so that keeps happening: build on
Seer and your work stays open too, so the next person gets the same head start.

- **[AGPL-3.0-or-later](https://github.com/Shaid/seer/blob/main/LICENSE)** —
  free for personal, educational and open-source use. Note that the AGPL extends
  copyleft to **network use**: run a public web app or hosted service on this
  and you must publish your application's source under the AGPL.
- **Commercial licence** — waives that requirement so a proprietary or
  closed-source product can keep its codebase private. Flat-fee and subscription
  terms are available, and custom terms are negotiable.

If the copyleft doesn't fit what you're building, we would much rather have the
conversation than have you walk away — email
[dr.shaid@gmail.com](mailto:dr.shaid@gmail.com) with the subject
`[Commercial License Request - Project Name]`.

Full details: <https://seer.shaid.net/start-here/licensing/>.

# @seer-project/iff

IFF-85 (Interchange File Format) parser.

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

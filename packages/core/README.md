# @seer/core

Generic binary utilities for browser-based reverse-engineering projects.

Zero runtime dependencies. Browser-safe (no Node built-ins). This is the
foundation package that all other `@seer/*` packages depend on.

## Installation

```bash
npm install @seer/core
```

## Modules

### `binary.ts` — Low-level byte readers

Standalone functions for reading unsigned integers from `Uint8Array` with
configurable endianness. No format assumptions — safe for any binary target.

```ts
import { r8, r16, r24, r32 } from '@seer/core';

const value = r32(data, offset, 'be'); // uint32, big-endian
```

| Function | Width | Notes |
| --- | --- | --- |
| `r8(data, offset)` | 8-bit | Endianness N/A |
| `r16(data, offset, endian)` | 16-bit | `'be'` or `'le'` |
| `r24(data, offset, endian)` | 24-bit | |
| `r32(data, offset, endian)` | 32-bit | Returns unsigned (`>>> 0`) |
| `dataViewOf(data)` | — | Create a `DataView` over a `Uint8Array` |

### `binary-reader.ts` — Sequential cursor reader

`BinaryReader` wraps an `ArrayBuffer` with a sequential read cursor.
Endianness is a constructor parameter (default big-endian).

```ts
import { BinaryReader } from '@seer/core';

const reader = new BinaryReader(buffer, 0, 'be');
const magic = reader.readFourCC();   // "FORM"
const size  = reader.readUint32();
const chunk = reader.readBytes(size);
```

| Method | Returns | Description |
| --- | --- | --- |
| `readUint8()` / `readInt8()` | `number` | 8-bit integer |
| `readUint16()` / `readInt16()` | `number` | 16-bit integer |
| `readUint32()` / `readInt32()` | `number` | 32-bit integer |
| `readFourCC()` | `string` | 4-byte ASCII chunk ID |
| `readBytes(n)` | `Uint8Array` | Raw byte slice |
| `readCString(max?)` | `string` | Null-terminated ASCII string |
| `readString(len)` | `string` | Fixed-length ASCII string |
| `subReader(len)` | `BinaryReader` | Sub-reader for a byte range |
| `seek(offset)` / `skip(bytes)` | `void` | Move the cursor |

### `assets.ts` — Runtime asset loader

Fetch preprocessed JSON (and text) assets produced by the offline pipeline.
Browser-safe — uses `globalThis.fetch`, no Node built-ins.

Lives in `@seer/core` (not `@seer/pipeline`) to prevent Node-only
dependencies from leaking into browser bundles.

```ts
import { loadAssets } from '@seer/core';

interface MyAssets {
  atlas: { cellWidth: number; cellHeight: number };
  map: { cols: number };
}

const assets = await loadAssets<MyAssets>('/assets/mygame/amiga', {
  atlas: 'atlas.json',
  map: 'map.json',
});
```

Or use the factory for reusable loading:

```ts
import { createAssetLoader } from '@seer/core';

const load = createAssetLoader('/assets/mygame/amiga');
const assets = await load<MyAssets>({ atlas: 'atlas.json', map: 'map.json' });
```

## Testing

```bash
npm test
npm run lint
```

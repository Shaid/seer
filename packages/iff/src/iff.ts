/**
 * IFF (Interchange File Format) parser.
 *
 * IFF is a real, well-documented container format (EA IFF-85) used widely on
 * the Amiga and by several cross-platform tools of the era. This decoder is
 * a generic implementation of the public spec — not tied to any specific
 * game — and is reusable whenever your target uses IFF-derived formats
 * (8SVX, ILBM, ANIM, SMUS, or a custom FORM-based format).
 *
 * Structure: FORM <size> <type> <chunks...>
 * Each chunk: <fourCC> <size:uint32> <data...> [pad byte if odd size]
 */
import { BinaryReader } from '@seer-project/core';

export interface IffChunk {
  id: string;
  size: number;
  data: Uint8Array;
}

export interface IffForm {
  type: string;
  chunks: IffChunk[];
}

/** Parse an IFF FORM from a buffer. Returns null if not a valid IFF. */
export function parseIff(buffer: ArrayBuffer): IffForm | null {
  const reader = new BinaryReader(buffer);

  if (reader.length < 12) return null;

  const formId = reader.readFourCC();
  if (formId !== 'FORM') return null;

  const formSize = reader.readUint32();
  const formType = reader.readFourCC();

  const chunks: IffChunk[] = [];
  const endOffset = Math.min(8 + formSize, reader.length);

  while (reader.offset < endOffset) {
    if (reader.remaining < 8) break;

    const chunkId = reader.readFourCC();
    const chunkSize = reader.readUint32();

    if (reader.offset + chunkSize > reader.length) break;

    const data = reader.readBytes(chunkSize);
    chunks.push({ id: chunkId, size: chunkSize, data });

    // IFF chunks are padded to even byte boundaries
    if (chunkSize % 2 !== 0 && reader.offset < endOffset) {
      reader.skip(1);
    }
  }

  return { type: formType, chunks };
}

/** Find a chunk by ID within an IFF form. */
export function findChunk(form: IffForm, id: string): IffChunk | undefined {
  return form.chunks.find((c) => c.id === id);
}

/** Find all chunks with a given ID. */
export function findChunks(form: IffForm, id: string): IffChunk[] {
  return form.chunks.filter((c) => c.id === id);
}

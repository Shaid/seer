/**
 * Minimal hand-rolled encoder for CRI's `@UTF` table format — the inverse
 * of `cpk.ts`'s `parseUtf`/`readUtfRow`, built purely for these tests so
 * they can construct synthetic (non-corpus) fixtures for CPK/AWB/ACB
 * decoding without shipping real extracted game bytes in this package.
 *
 * Supports only what the tests need: per-row storage (0x50) and
 * constant storage (0x30) columns, types 0/1 (u8), 2/3 (u16), 4/5 (u32),
 * 6/7 (u64), 8 (f32), 0xa (string), 0xb (data blob — nested `@UTF` tables
 * included, since a blob is just raw bytes).
 *
 * Byte layout mirrors `parseUtf`/`readUtfRow` exactly — see `cpk.ts`'s own
 * doc comments for the field-by-field derivation this is built against.
 */

export type UtfTypeCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 0xa | 0xb;
export type UtfBuildValue = number | bigint | string | Uint8Array;

export interface UtfColSpec {
  name: string;
  typ: UtfTypeCode;
  /** Default 'row' (storage 0x50, one value per row). 'const' (storage 0x30) embeds one shared value in the schema itself. */
  storage?: 'row' | 'const';
  /** Required when storage is 'const'. */
  constantValue?: UtfBuildValue;
}

function widthOf(typ: UtfTypeCode): number {
  switch (typ) {
    case 0:
    case 1:
      return 1;
    case 2:
    case 3:
      return 2;
    case 4:
    case 5:
      return 4;
    case 6:
    case 7:
      return 8;
    case 8:
      return 4;
    case 0xa:
      return 4;
    case 0xb:
      return 8;
  }
}

class ByteSink {
  bytes: number[] = [];
  push(...b: number[]): void {
    this.bytes.push(...b);
  }
  pushU32(v: number): void {
    this.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  get length(): number {
    return this.bytes.length;
  }
}

/** Build one `@UTF` table packet from a column schema and a list of rows (each a name -> value map covering every 'row'-storage column). */
export function buildUtf(columns: UtfColSpec[], rows: Record<string, UtfBuildValue>[]): Uint8Array {
  const strings: number[] = [];
  const stringCache = new Map<string, number>();
  function internString(s: string): number {
    const cached = stringCache.get(s);
    if (cached !== undefined) return cached;
    const offset = strings.length;
    for (let i = 0; i < s.length; i++) strings.push(s.charCodeAt(i) & 0x7f);
    strings.push(0);
    stringCache.set(s, offset);
    return offset;
  }
  internString(''); // offset 0 -> empty string, used as the table-name placeholder

  const data: number[] = [];
  function internBlob(bytes: Uint8Array): { offset: number; length: number } {
    const offset = data.length;
    for (const b of bytes) data.push(b);
    return { offset, length: bytes.length };
  }

  function pushValue(sink: ByteSink, typ: UtfTypeCode, value: UtfBuildValue): void {
    switch (typ) {
      case 0:
      case 1:
        sink.push(Number(value) & 0xff);
        return;
      case 2:
      case 3: {
        const v = Number(value) & 0xffff;
        sink.push((v >> 8) & 0xff, v & 0xff);
        return;
      }
      case 4:
      case 5:
        sink.pushU32(Number(value) >>> 0);
        return;
      case 6:
      case 7: {
        const v = BigInt(value as bigint | number);
        for (let i = 7; i >= 0; i--) sink.push(Number((v >> BigInt(i * 8)) & 0xffn));
        return;
      }
      case 8: {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setFloat32(0, Number(value), false);
        sink.push(...b);
        return;
      }
      case 0xa:
        sink.pushU32(internString(String(value)));
        return;
      case 0xb: {
        const blob = internBlob(value as Uint8Array);
        sink.pushU32(blob.offset);
        sink.pushU32(blob.length);
        return;
      }
    }
  }

  const schema = new ByteSink();
  let rowLength = 0;
  for (const col of columns) {
    const storage = col.storage === 'const' ? 0x30 : 0x50;
    schema.push(storage | col.typ);
    schema.pushU32(internString(col.name));
    if (storage === 0x30) {
      pushValue(schema, col.typ, col.constantValue!);
    } else {
      rowLength += widthOf(col.typ);
    }
  }

  const rowSink = new ByteSink();
  for (const row of rows) {
    for (const col of columns) {
      if (col.storage === 'const') continue;
      pushValue(rowSink, col.typ, row[col.name]!);
    }
  }

  const rowsOffsetAbs = 32 + schema.length;
  const rowsOffset = rowsOffsetAbs - 8;
  const stringsOffsetAbs = rowsOffsetAbs + rowSink.length;
  const stringsOffset = stringsOffsetAbs - 8;
  const dataOffsetAbs = stringsOffsetAbs + strings.length;
  const dataOffset = dataOffsetAbs - 8;
  const total = dataOffsetAbs + data.length;
  const tableSize = total - 8;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x40, 0x55, 0x54, 0x46], 0); // "@UTF"
  view.setUint32(4, tableSize, false);
  view.setUint32(8, rowsOffset, false);
  view.setUint32(12, stringsOffset, false);
  view.setUint32(16, dataOffset, false);
  view.setUint32(20, 0, false); // tableName -> offset 0 (empty string), unused by cpk.ts's readers
  view.setUint16(24, columns.length, false);
  view.setUint16(26, rowLength, false);
  view.setUint32(28, rows.length, false);
  out.set(schema.bytes, 32);
  out.set(rowSink.bytes, rowsOffsetAbs);
  out.set(strings, stringsOffsetAbs);
  out.set(data, dataOffsetAbs);
  return out;
}

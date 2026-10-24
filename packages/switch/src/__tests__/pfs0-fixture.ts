/**
 * A synthetic two-file PFS0, shared by the parser test and the on-disk
 * test so both are pinned against the same bytes.
 */
import { PFS0_ENTRY_SIZE, PFS0_HEADER_SIZE } from '../pfs0.js';

/** Build a PFS0 whose files are `[name, bytes]` pairs, in order. */
export function buildPfs0(files: [string, Uint8Array][]): Uint8Array {
  const nameBytes = files.map(([n]) => Uint8Array.from(`${n}\0`, (c) => c.charCodeAt(0)));
  const nameLen = nameBytes.reduce((a, b) => a + b.length, 0);
  // Real NSPs pad the string table so the data base is 0x10-aligned; the
  // parser must take the padded size from the header, not recompute it.
  const strSize = Math.ceil(nameLen / 0x10) * 0x10;
  const stringBase = PFS0_HEADER_SIZE + files.length * PFS0_ENTRY_SIZE;
  const headerLength = stringBase + strSize;
  const dataLen = files.reduce((a, [, b]) => a + b.length, 0);
  const out = new Uint8Array(headerLength + dataLen);
  const view = new DataView(out.buffer);
  out.set(Uint8Array.from('PFS0', (c) => c.charCodeAt(0)), 0);
  view.setUint32(4, files.length, true);
  view.setUint32(8, strSize, true);

  let dataOff = 0;
  let nameOff = 0;
  files.forEach(([, bytes], i) => {
    const e = PFS0_HEADER_SIZE + i * PFS0_ENTRY_SIZE;
    view.setBigUint64(e, BigInt(dataOff), true);
    view.setBigUint64(e + 8, BigInt(bytes.length), true);
    view.setUint32(e + 16, nameOff, true);
    out.set(nameBytes[i]!, stringBase + nameOff);
    out.set(bytes, headerLength + dataOff);
    dataOff += bytes.length;
    nameOff += nameBytes[i]!.length;
  });
  return out;
}

export const META = Uint8Array.from([1, 2, 3, 4, 5]);
export const PROGRAM = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);

/** The two-entry NSP both suites use, and the data base its entries sit at. */
export const FIXTURE_FILES: [string, Uint8Array][] = [
  ['abc.cnmt.nca', META],
  ['def.nca', PROGRAM],
];
export const FIXTURE_BASE = PFS0_HEADER_SIZE + 2 * PFS0_ENTRY_SIZE + 0x20;

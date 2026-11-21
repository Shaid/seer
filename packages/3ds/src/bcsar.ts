/**
 * BCSAR (`CSAR`) CTR sound archive — index, names and the wave containers.
 *
 * Verified on Fire Emblem Awakening/Fates/Warriors and Bravely Default/Second
 * archives (all `version` 0x02040000-family; see `docs/3ds-formats.md` §12.2 in
 * the lucina project for the evidence).
 *
 * Archive (little-endian; every "ref" is `u16 type, u16 pad, u32 offset`):
 *   0x00 "CSAR"  0x04 u16 BOM 0xFEFF  0x06 u16 headerSize 0x40  0x08 u32 version
 *   0x0c u32 fileSize  0x10 u16 blockCount  0x14 blockCount x { u16 type, u16 pad,
 *   u32 offset, u32 size } — 0x2000 STRG, 0x2001 INFO, 0x2002 FILE.
 *   STRG: "STRG" u32 size, refs at +8 (0x2400 string table, 0x2401 lookup tree);
 *     table = u32 count + count x { u16 0x1f01, pad, u32 offset-from-table, u32 size incl NUL }.
 *   INFO: "INFO" u32 size, then 8 refs at +8 (offsets relative to INFO+8):
 *     0x2100 sounds, 0x2104 sound groups, 0x2101 banks, 0x2103 wave archives,
 *     0x2105 groups, 0x2102 players, 0x2106 files, 0x220b archive header.
 *     Each table = u32 count + count x ref; entry refs are relative to the table start.
 *   Sound (ref 0x2200): +0 u32 fileId, +4 u32 playerId (type in the top byte),
 *     +8 u8 volume, +0xc ref {0x2201 stream | 0x2202 wave | 0x2203 sequence},
 *     +0x18 u32 stringId; the typed record sits at entry+ref.offset:
 *     wave: +0 u32 index into the CWSD file; sequence: +0 ref {0x0100, off} to a
 *     bank-id table (u32 count + ids, top byte 3), +0x10 u32 CSEQ label offset.
 *   Wave archive (0x2207): +0 u32 fileId, +4 u32 flag. flag 1: 20-byte record
 *     {+8 u32 3, +0xc u32 stringId, +0x10 u32 waveCount}; flag 0: 12-byte record, no name/count.
 *   Bank (0x2206): +0 u32 fileId, +0x10 u32 stringId; the CBNK file's wave-id table
 *     names the wave archives it uses.
 *   Sound group (0x2204): +0 first sound id, +4 last sound id, +0x1c u32 stringId.
 *   File (0x220a): +0 ref {0x220c internal | 0x220d external}; internal record at
 *     entry+0xc = { u16 0x1f00 pad, u32 offset (from FILE+8), u32 size } (offset at
 *     entry+0x10); external = a NUL-terminated path at entry+0xc.
 *   FILE block: "FILE" u32 size, payloads start at FILE+8.
 *
 * Embedded file kinds (magic): CWSD wave-sound set, CWAR wave archive (of CWAV),
 * CBNK bank, CSEQ sequence, CGRP group.
 */
import { u16At, u32At } from './le.js';

export interface CsarBlock {
  type: number;
  offset: number;
  size: number;
}

export type CsarSoundKind = 'stream' | 'wave' | 'sequence' | 'unknown';

export interface CsarSound {
  index: number;
  name: string;
  fileId: number;
  playerId: number;
  volume: number;
  kind: CsarSoundKind;
  /** Wave sounds: index of the wave sound inside its CWSD file. */
  waveSoundIndex?: number;
  /** Raw typed-record words (first 4) for sequence/stream sounds. */
  typed: number[];
  /** Sequence sounds: CSEQ label offset (`fileId` is the CSEQ file) and the banks (indices into `Csar.banks`) it plays. */
  sequence?: { labelOffset: number; bankIds: number[] };
}

export interface CsarWaveArchive {
  index: number;
  /** STRG name; empty when the 12-byte record variant (no name/count) is used. */
  name: string;
  fileId: number;
  /** Declared wave count (0 for the nameless 12-byte records — read it from the CWAR instead). */
  waveCount: number;
}

export interface CsarSoundGroup {
  index: number;
  name: string;
  /** First/last sound index (ids are `0x01000000 | index`). */
  firstSound: number;
  lastSound: number;
}

export interface CsarBank {
  index: number;
  name: string;
  fileId: number;
}

export interface CsarFile {
  id: number;
  /** `internal`: payload in the FILE block; `external`: separate file at `path`. */
  location: 'internal' | 'external';
  /** Absolute offset in the .bcsar of an internal payload. */
  offset?: number;
  size?: number;
  path?: string;
}

export interface Csar {
  version: number;
  fileSize: number;
  blocks: CsarBlock[];
  strings: string[];
  sounds: CsarSound[];
  waveArchives: CsarWaveArchive[];
  soundGroups: CsarSoundGroup[];
  banks: CsarBank[];
  files: CsarFile[];
  /** Counts of every INFO table (`0x2100` ...). */
  infoCounts: Record<string, number>;
}

/** Byte length of the prefix (header through the end of INFO) needed by {@link parseCsar}. */
export function csarHeadLength(d: Uint8Array): number {
  const n = u16At(d, 0x10);
  let end = 0;
  for (let i = 0; i < n; i++) {
    const t = u16At(d, 0x14 + 12 * i);
    if (t === 0x2000 || t === 0x2001) end = Math.max(end, u32At(d, 0x14 + 12 * i + 4) + u32At(d, 0x14 + 12 * i + 8));
  }
  return end;
}

function ascii(d: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(d[o + i]!);
  return s;
}

function cstr(d: Uint8Array, o: number): string {
  let e = o;
  while (e < d.length && d[e] !== 0) e++;
  return new TextDecoder().decode(d.subarray(o, e));
}

/** Parse the archive index from `d` = the file prefix covering STRG and INFO (see {@link csarHeadLength}). */
export function parseCsar(d: Uint8Array, fileSize: number): Csar {
  if (d.length < 0x40 || ascii(d, 0, 4) !== 'CSAR') throw new Error('Not a CSAR');
  if (u16At(d, 4) !== 0xfeff || u32At(d, 0xc) !== fileSize) throw new Error('CSAR: bad header');
  const n = u16At(d, 0x10);
  const blocks: CsarBlock[] = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ type: u16At(d, 0x14 + 12 * i), offset: u32At(d, 0x14 + 12 * i + 4), size: u32At(d, 0x14 + 12 * i + 8) });
  }
  const strg = blocks.find((b) => b.type === 0x2000);
  const info = blocks.find((b) => b.type === 0x2001);
  const fileBlock = blocks.find((b) => b.type === 0x2002);
  if (!strg || !info) throw new Error('CSAR: missing STRG/INFO');
  if (d.length < Math.max(strg.offset + strg.size, info.offset + info.size)) throw new Error('CSAR: prefix too short');
  if (ascii(d, strg.offset, 4) !== 'STRG' || ascii(d, info.offset, 4) !== 'INFO') throw new Error('CSAR: bad block magic');

  // STRG string table
  const sb = strg.offset + 8;
  let tbl = -1;
  for (let i = 0; i < 2; i++) if (u16At(d, sb + 8 * i) === 0x2400) tbl = sb + u32At(d, sb + 8 * i + 4);
  if (tbl < 0) throw new Error('CSAR: no string table');
  const count = u32At(d, tbl);
  const strings: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = tbl + 4 + 12 * i;
    if (u16At(d, r) !== 0x1f01) throw new Error('CSAR: bad string ref');
    const o = tbl + u32At(d, r + 4);
    const sz = u32At(d, r + 8);
    strings.push(new TextDecoder().decode(d.subarray(o, o + Math.max(0, sz - 1))));
  }
  const nameOf = (id: number): string => (id < strings.length ? strings[id]! : `#${id}`);

  // INFO tables
  const ib = info.offset + 8;
  const tables = new Map<number, number>();
  const infoCounts: Record<string, number> = {};
  for (let i = 0; i < 8; i++) {
    const t = u16At(d, ib + 8 * i);
    const off = ib + u32At(d, ib + 8 * i + 4);
    tables.set(t, off);
    if (t !== 0x220b) infoCounts['0x' + t.toString(16)] = u32At(d, off);
  }
  const entries = (t: number): number[] => {
    const b = tables.get(t);
    if (b === undefined) return [];
    const c = u32At(d, b);
    const out: number[] = [];
    for (let i = 0; i < c; i++) out.push(b + u32At(d, b + 4 + 8 * i + 4));
    return out;
  };

  const sounds: CsarSound[] = entries(0x2100).map((e, index) => {
    const kt = u16At(d, e + 0xc);
    const kind: CsarSoundKind = kt === 0x2201 ? 'stream' : kt === 0x2202 ? 'wave' : kt === 0x2203 ? 'sequence' : 'unknown';
    const typed = e + u32At(d, e + 0xc + 4);
    const s: CsarSound = {
      index,
      name: nameOf(u32At(d, e + 0x18)),
      fileId: u32At(d, e),
      playerId: u32At(d, e + 4),
      volume: d[e + 8]!,
      kind,
      typed: [0, 1, 2, 3].map((k) => u32At(d, typed + 4 * k)),
    };
    if (kind === 'wave') s.waveSoundIndex = u32At(d, typed);
    if (kind === 'sequence') {
      const tab = typed + u32At(d, typed + 4);
      const nb = u32At(d, tab);
      const bankIds: number[] = [];
      for (let k = 0; k < Math.min(nb, 16); k++) bankIds.push(u32At(d, tab + 4 + 4 * k) & 0xffffff);
      s.sequence = { labelOffset: u32At(d, typed + 0x10), bankIds };
    }
    return s;
  });
  // Wave archive record: u32 fileId, u32 flag; flag 1 = 20-byte record with
  // { u32 3, u32 stringId, u32 waveCount }, flag 0 = 12-byte record (fileId, 0, 0).
  const waveArchives: CsarWaveArchive[] = entries(0x2103).map((e, index) => {
    const named = u32At(d, e + 4) === 1;
    return {
      index,
      name: named ? nameOf(u32At(d, e + 0xc)) : '',
      fileId: u32At(d, e),
      waveCount: named ? u32At(d, e + 0x10) : 0,
    };
  });
  const soundGroups: CsarSoundGroup[] = entries(0x2104).map((e, index) => ({
    index,
    name: nameOf(u32At(d, e + 0x1c)),
    firstSound: u32At(d, e) & 0xffffff,
    lastSound: u32At(d, e + 4) & 0xffffff,
  }));
  const banks: CsarBank[] = entries(0x2101).map((e, index) => ({ index, name: nameOf(u32At(d, e + 0x10)), fileId: u32At(d, e) }));
  const dataStart = fileBlock ? fileBlock.offset + 8 : 0;
  const files: CsarFile[] = entries(0x2106).map((e, id) => {
    const t = u16At(d, e);
    if (t === 0x220c) {
      return { id, location: 'internal', offset: dataStart + u32At(d, e + 0x10), size: u32At(d, e + 0x14) };
    }
    if (t === 0x220d) return { id, location: 'external', path: cstr(d, e + u32At(d, e + 4)) };
    throw new Error(`CSAR: file ${id} has unknown location type 0x${t.toString(16)}`);
  });
  return { version: u32At(d, 8), fileSize, blocks, strings, sounds, waveArchives, soundGroups, banks, files, infoCounts };
}

/** Magic tag of an embedded CTR SDK file (`CWSD`, `CWAR`, `CBNK`, `CSEQ`, `CGRP`, `CWAV`, `CSTM`). */
export function csarFileKind(head: Uint8Array): string {
  return head.length >= 4 ? ascii(head, 0, 4) : '';
}

export interface CwarWave {
  /** Offset of the CWAV inside the CWAR file. */
  offset: number;
  size: number;
}

/**
 * CWAR wave archive: header 0x40, `INFO` block (u32 count + count x
 * { u16 0x1f00, pad, u32 offset-from-FILE+8, u32 size }) then a `FILE` block.
 * `d` needs only the header + INFO (first `0x40 + infoSize` bytes). A zero offset
 * means an empty slot (returned as `undefined`).
 */
export function parseCwar(d: Uint8Array): (CwarWave | undefined)[] {
  if (ascii(d, 0, 4) !== 'CWAR') throw new Error('Not a CWAR');
  const n = u16At(d, 0x10);
  let info = -1;
  let file = -1;
  for (let i = 0; i < n; i++) {
    const t = u16At(d, 0x14 + 12 * i);
    if (t === 0x6800) info = u32At(d, 0x14 + 12 * i + 4);
    else if (t === 0x6801) file = u32At(d, 0x14 + 12 * i + 4);
  }
  if (info < 0 || file < 0 || ascii(d, info, 4) !== 'INFO') throw new Error('CWAR: missing INFO/FILE');
  const count = u32At(d, info + 8);
  const out: (CwarWave | undefined)[] = [];
  for (let i = 0; i < count; i++) {
    const e = info + 0xc + 12 * i;
    const t = u16At(d, e);
    if (t !== 0x1f00) {
      out.push(undefined);
      continue;
    }
    out.push({ offset: file + 8 + u32At(d, e + 4), size: u32At(d, e + 8) });
  }
  return out;
}

export interface CwsdWaveSound {
  /** Index into this set's wave-id table. */
  waveIndex: number;
}

export interface Cwsd {
  /** wave-id table: `archiveId` is a wave-archive item id (top byte 5, low bytes = index into the archive table). */
  waveIds: { archiveId: number; waveIndex: number }[];
  /** Per wave sound: the wave-id table entry it plays. */
  waveSounds: CwsdWaveSound[];
}

/**
 * CWSD wave-sound set. INFO (at the 0x20 header) holds `ref 0x0100` -> wave-id
 * table (u32 count + { u32 archiveId, u32 waveIndex }) and `ref 0x0101` -> a table
 * of refs (0x4900) to wave-sound records; each record's +0x10 ref (0x0101) points at a
 * one-entry table whose element starts with the wave-id index. All offsets in the
 * INFO payload are relative to INFO+8 (table-internal refs: to the table / record start).
 */
export function parseCwsd(d: Uint8Array): Cwsd {
  if (ascii(d, 0, 4) !== 'CWSD') throw new Error('Not a CWSD');
  const info = u32At(d, 0x18);
  if (ascii(d, info, 4) !== 'INFO') throw new Error('CWSD: bad INFO');
  const base = info + 8;
  let idTable = -1;
  let wsTable = -1;
  for (let i = 0; i < 2; i++) {
    const t = u16At(d, base + 8 * i);
    const o = base + u32At(d, base + 8 * i + 4);
    if (t === 0x0100) idTable = o;
    else if (t === 0x0101) wsTable = o;
  }
  if (idTable < 0 || wsTable < 0) throw new Error('CWSD: missing tables');
  const waveIds: Cwsd['waveIds'] = [];
  const nIds = u32At(d, idTable);
  for (let i = 0; i < nIds; i++) waveIds.push({ archiveId: u32At(d, idTable + 4 + 8 * i), waveIndex: u32At(d, idTable + 4 + 8 * i + 4) });
  const waveSounds: CwsdWaveSound[] = [];
  const nWs = u32At(d, wsTable);
  for (let i = 0; i < nWs; i++) {
    const rec = wsTable + u32At(d, wsTable + 4 + 8 * i + 4);
    // ref at rec+0x10 -> one-entry table (count, ref) -> { u32 waveIndex }
    const tbl = rec + u32At(d, rec + 0x14);
    const el = tbl + u32At(d, tbl + 4 + 4);
    waveSounds.push({ waveIndex: u32At(d, el) });
  }
  return { waveIds, waveSounds };
}

/**
 * CBNK bank: INFO (at the 0x20 header) holds `ref 0x0100` -> wave-id table
 * (u32 count + { u32 waveArchiveItemId, u32 waveIndex }) and `ref 0x0101` -> the
 * instrument table (not decoded). Offsets are relative to INFO+8.
 */
export function parseCbnkWaveIds(d: Uint8Array): { archiveId: number; waveIndex: number }[] {
  if (ascii(d, 0, 4) !== 'CBNK') throw new Error('Not a CBNK');
  const info = u32At(d, 0x18);
  if (ascii(d, info, 4) !== 'INFO') throw new Error('CBNK: bad INFO');
  const base = info + 8;
  for (let i = 0; i < 2; i++) {
    if (u16At(d, base + 8 * i) !== 0x0100) continue;
    const t = base + u32At(d, base + 8 * i + 4);
    const n = u32At(d, t);
    const out: { archiveId: number; waveIndex: number }[] = [];
    for (let k = 0; k < n; k++) out.push({ archiveId: u32At(d, t + 4 + 8 * k), waveIndex: u32At(d, t + 8 + 8 * k) });
    return out;
  }
  throw new Error('CBNK: no wave-id table');
}

export interface CsarWaveArchiveLayout {
  archive: CsarWaveArchive;
  /** Directory-style name: the archive's own STRG name, else its bank's, else its wave-sound set's, else `warc<index>`. */
  name: string;
  nameSource: 'archive' | 'bank' | 'soundgroup' | 'index';
  /** Wave index -> names of the sounds that play it (wave sounds; first is primary). */
  waveNames: Map<number, string[]>;
}

export interface CsarWaveLayout {
  archives: CsarWaveArchiveLayout[];
  /** Wave sounds whose CWSD/wave-id/archive reference was out of range. */
  unresolved: number;
}

/**
 * Resolve names for every wave archive and wave:
 *  - wave sound -> CWSD file (`fileId`) -> wave sound `waveSoundIndex` -> wave-id table ->
 *    (wave archive item id, wave index); the item id's low 24 bits index `csar.waveArchives`;
 *  - a bank's CBNK wave-id table names the archives it uses (`BANK_x`);
 *  - a sound's group (by sound index range) names its CWSD file's archives.
 * `cwsds`/`cbnks` map CSAR file ids to the parsed embedded files.
 */
export function resolveCsarWaveLayout(
  csar: Csar,
  cwsds: ReadonlyMap<number, Cwsd>,
  cbnks: ReadonlyMap<number, { archiveId: number; waveIndex: number }[]>,
): CsarWaveLayout {
  const archives: CsarWaveArchiveLayout[] = csar.waveArchives.map((archive) => ({
    archive,
    name: archive.name || `warc${archive.index}`,
    nameSource: archive.name ? 'archive' : 'index',
    waveNames: new Map(),
  }));
  const groupOf = (soundIndex: number): CsarSoundGroup | undefined =>
    csar.soundGroups.find((g) => soundIndex >= g.firstSound && soundIndex <= g.lastSound);
  const rename = (a: CsarWaveArchiveLayout, name: string, src: CsarWaveArchiveLayout['nameSource']) => {
    if (a.nameSource === 'index' && name) {
      a.name = name;
      a.nameSource = src;
    }
  };
  for (const b of csar.banks) {
    for (const id of cbnks.get(b.fileId) ?? []) {
      const a = archives[id.archiveId & 0xffffff];
      if (a) rename(a, b.name.replace(/^BANK_/, ''), 'bank');
    }
  }
  let unresolved = 0;
  for (const s of csar.sounds) {
    if (s.kind !== 'wave') continue;
    const cwsd = cwsds.get(s.fileId);
    const ws = cwsd?.waveSounds[s.waveSoundIndex ?? -1];
    const wid = ws ? cwsd!.waveIds[ws.waveIndex] : undefined;
    const a = wid ? archives[wid.archiveId & 0xffffff] : undefined;
    if (!wid || !a) {
      unresolved++;
      continue;
    }
    const l = a.waveNames.get(wid.waveIndex);
    if (l) l.push(s.name);
    else a.waveNames.set(wid.waveIndex, [s.name]);
    const g = groupOf(s.index);
    if (g) rename(a, g.name, 'soundgroup');
  }
  return { archives, unresolved };
}

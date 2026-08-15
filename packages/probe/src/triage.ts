/**
 * `seer-probe triage <dir>` — whole-corpus first contact.
 *
 * Walks a directory tree and produces, per top-level subdirectory (one
 * game per subdirectory is the corpus convention), an extension →
 * dominant-class table plus every container hit — the ranked work-list a
 * recon session starts from. Promoted from a scratch script after being
 * hand-rewritten for the third corpus in a row.
 *
 * Corpus-shape awareness (TOSEC-style collections):
 * - ZIP archives are descended into. The central directory (which
 *   carries every member's CRC-32) lives at the END of the file, so an
 *   archive whose members were all seen before is skipped having read
 *   only its tail — never the payloads. On a network share that is the
 *   difference between minutes and hours.
 * - ADF images with a walkable AmigaDOS filesystem are descended into
 *   (each contained file triaged individually); RawDIC/trackloader
 *   images stay opaque blobs, which is itself signal.
 * - WHDLoad `.slave` files are parsed for the game's real name/copy
 *   strings — the one machine-readable label in every install.
 * - Files above `--full-read-mb` are SAMPLED, not read whole: head and
 *   tail only. Their classification and container scan therefore see a
 *   prefix, and their dedupe key is (size, head CRC, tail CRC) rather
 *   than a whole-file CRC. Both facts are counted and reported rather
 *   than glossed — a sampled duplicate is a very strong claim, not a
 *   proven one.
 *
 * Same rule as every other command: hypotheses ranked for follow-up,
 * not findings.
 */

import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import {
  isAdfSize,
  isHunkFile,
  isLhaFile,
  listAdf,
  listLha,
  parseWhdloadSlave,
  readAdfFile,
  readLhaEntry,
} from '@seer-project/amiga';
import { writeJson } from '@seer-project/pipeline';
import { parseFlags } from './args.js';
import { classifyRegions } from './classify.js';
import { scanContainers, type ContainerHit } from './audio.js';
import { artifactPath, ensureOutDir } from './out.js';
import { bufferSource, fileSource, type ByteSource } from './source.js';
import { crc32, isZipFile, listZipFromSource, readZipEntryFromSource } from './zip.js';

export interface TriageFileInfo {
  dominantClass: string;
  isHunk: boolean;
  isAdf: boolean;
  containers: ContainerHit[];
}

/** Classify one file's bytes. Pure — no I/O. */
export function triageFile(data: Uint8Array, window = 1024): TriageFileInfo {
  const regions = classifyRegions(data, data.length > (1 << 21) ? 4096 : window);
  const byClass = new Map<string, number>();
  for (const r of regions) byClass.set(r.class, (byClass.get(r.class) ?? 0) + r.len);
  const dominant = [...byClass.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'empty';
  return {
    dominantClass: dominant,
    isHunk: isHunkFile(data),
    isAdf: isAdfSize(data.length),
    containers: scanContainers(data),
  };
}

export interface ExtSummary {
  ext: string;
  count: number;
  bytes: number;
  hunk: number;
  adf: number;
  /** Dominant-class tallies, e.g. "packed-records×35, pcm-audio?×2". */
  classes: string;
}

export interface SlaveInfo {
  file: string;
  version: number;
  name: string | null;
  copy: string | null;
}

export interface GroupSummary {
  group: string;
  files: number;
  bytes: number;
  extensions: ExtSummary[];
  containerHits: number;
  containers: (ContainerHit & { file: string })[];
  slaves: SlaveInfo[];
  /** Payloads skipped because an identical one was already triaged this run. */
  duplicatesSkipped: number;
  /** Files classified from a head/tail sample rather than read whole. */
  sampledFiles: number;
}

export interface TriageReport {
  root: string;
  files: number;
  groups: GroupSummary[];
  /** Total bytes of every file visited. */
  totalBytes: number;
  /** Bytes actually read — the network cost. Lower than `totalBytes` when archives and large files were skipped or sampled. */
  bytesRead: number;
  duplicatesSkipped: number;
  sampledFiles: number;
}

interface ExtAccumulator {
  count: number;
  bytes: number;
  hunk: number;
  adf: number;
  classes: Map<string, number>;
}

interface GroupAccumulator {
  files: number;
  bytes: number;
  exts: Map<string, ExtAccumulator>;
  containers: (ContainerHit & { file: string })[];
  hits: number;
  slaves: SlaveInfo[];
  dups: number;
  sampled: number;
}

/** Amiga icon/metadata sidecars — noise in every corpus, never data. */
const SKIP_FILE = /\.(info|uaem)$/i;

const MAX_CONTAINERS_PER_GROUP = 25;
/**
 * Whole-run ceiling on stored container records. Hits are always
 * counted; past this many the examples stop being kept, so the report
 * stays a bounded size on a corpus of any scale.
 */
const MAX_CONTAINERS_TOTAL = 50_000;

/**
 * TOSEC names a release `Title (year)(publisher)[flags]`, and a
 * collection holds many variants — cracks, alternates, trainers — of the
 * same game. Grouping by the title before the year collapses those onto
 * one entry, which is the unit a person actually cares about.
 */
export function tosecTitle(filename: string): string | null {
  const m = /^(.+?)\s*\((?:19|20)\d\d[^)]*\)/.exec(filename);
  if (!m) return null;
  const title = m[1].trim();
  return title.length > 0 ? title : null;
}
/** Files at or under this size are read whole (exact CRC, full classification). */
const DEFAULT_FULL_READ_BYTES = 8 * 1024 * 1024;
/** Head/tail sample size for larger files. */
const SAMPLE_BYTES = 1024 * 1024;

export interface TriageOptions {
  /** Skip files larger than this (bytes). Default 4 GB. */
  maxFileBytes?: number;
  /** Read files up to this size whole; sample larger ones. Default 8 MB. */
  fullReadBytes?: number;
  /** Descend into ZIPs and walkable ADF filesystems. Default true. */
  descend?: boolean;
  onFile?: (path: string) => void;
}

/**
 * Triage every file under `root`, grouped by top-level subdirectory
 * (files directly in `root` group under "(root)").
 */
export function triageDirectory(root: string, opts: TriageOptions = {}): TriageReport {
  const maxBytes = opts.maxFileBytes ?? 4 * 1024 * 1024 * 1024;
  const fullReadBytes = opts.fullReadBytes ?? DEFAULT_FULL_READ_BYTES;
  const descend = opts.descend ?? true;
  const groups = new Map<string, GroupAccumulator>();
  const seenPayloads = new Set<string>();
  let storedContainers = 0;
  let fileCount = 0;
  let totalBytes = 0;
  let bytesRead = 0;

  const groupFor = (name: string): GroupAccumulator => {
    if (!groups.has(name)) {
      groups.set(name, {
        files: 0,
        bytes: 0,
        exts: new Map(),
        containers: [],
        hits: 0,
        slaves: [],
        dups: 0,
        sampled: 0,
      });
    }
    return groups.get(name)!;
  };

  const tally = (
    group: GroupAccumulator,
    displayPath: string,
    bytes: number,
    dominantClass: string,
    hunk: boolean,
    adf: boolean,
  ): void => {
    group.files++;
    group.bytes += bytes;
    const ext = (extname(basename(displayPath.split(/[!:]/).pop()!)) || '(none)').toLowerCase();
    if (!group.exts.has(ext)) group.exts.set(ext, { count: 0, bytes: 0, hunk: 0, adf: 0, classes: new Map() });
    const e = group.exts.get(ext)!;
    e.count++;
    e.bytes += bytes;
    if (hunk) e.hunk++;
    if (adf) e.adf++;
    e.classes.set(dominantClass, (e.classes.get(dominantClass) ?? 0) + 1);
  };

  /** Triage bytes already in memory (zip members, ADF file contents). */
  const recordBytes = (group: GroupAccumulator, displayPath: string, data: Uint8Array, depth: number): void => {
    if (descend && depth < 4 && isZipFile(data)) {
      if (recordZip(group, displayPath, bufferSource(data), depth)) return;
    }

    // LHA is how Amiga software is actually distributed — a WHDLoad
    // corpus is entirely opaque without descending into it.
    if (descend && depth < 4 && isLhaFile(data)) {
      let members: ReturnType<typeof listLha> = [];
      try {
        members = listLha(data);
      } catch {
        members = [];
      }
      if (members.length > 0) {
        tally(group, displayPath, data.length, 'lha-archive', false, false);
        for (const m of members) {
          if (m.isDirectory || m.originalSize === 0 || m.originalSize > maxBytes) continue;
          const key = `${m.originalSize}:${m.crc16}:lha`;
          if (seenPayloads.has(key)) {
            group.dups++;
            continue;
          }
          seenPayloads.add(key);
          try {
            recordBytes(group, `${displayPath}!${m.name}`, readLhaEntry(data, m), depth + 1);
          } catch {
            tally(group, `${displayPath}!${m.name}`, m.originalSize, 'unreadable-lha-member', false, false);
          }
        }
        return;
      }
    }

    // Walkable AmigaDOS disk: triage the files ON it, and record the
    // disk itself as a filesystem rather than classifying its bytes.
    if (descend && isAdfSize(data.length)) {
      const adfEntries = listAdf(data);
      if (adfEntries) {
        tally(group, displayPath, data.length, 'adf-dos-filesystem', false, true);
        for (const e of adfEntries) {
          if (e.type !== 'file' || e.size === 0 || e.size > maxBytes) continue;
          recordBytes(group, `${displayPath}:${e.path}`, readAdfFile(data, e), depth + 1);
        }
        return;
      }
    }

    const info = triageFile(data);
    tally(group, displayPath, data.length, info.dominantClass, info.isHunk, info.isAdf);
    for (const hit of info.containers) {
      group.hits++;
      if (group.containers.length < MAX_CONTAINERS_PER_GROUP && storedContainers < MAX_CONTAINERS_TOTAL) {
        group.containers.push({ ...hit, file: displayPath });
        storedContainers++;
      }
    }
    if (/\.slave$/i.test(displayPath) && info.isHunk) {
      const slave = parseWhdloadSlave(data);
      if (slave) {
        group.slaves.push({ file: displayPath, version: slave.version, name: slave.name, copy: slave.copy });
      }
    }
  };

  /**
   * Descend into an archive, reading only its tail plus the members that
   * haven't been seen before. Returns false when `src` isn't a parseable
   * ZIP, so the caller can fall back to blob treatment.
   */
  const recordZip = (group: GroupAccumulator, displayPath: string, src: ByteSource, depth: number): boolean => {
    const entries = listZipFromSource(src);
    if (!entries) return false;
    for (const entry of entries) {
      if (entry.size === 0 || entry.size > maxBytes) continue;
      const key = `${entry.size}:${entry.crc32}`;
      if (seenPayloads.has(key)) {
        group.dups++;
        continue;
      }
      seenPayloads.add(key);
      try {
        recordBytes(group, `${displayPath}!${entry.name}`, readZipEntryFromSource(src, entry), depth + 1);
      } catch {
        // Unsupported compression or a damaged member: count it unread.
        tally(group, `${displayPath}!${entry.name}`, entry.size, 'unreadable-zip-member', false, false);
      }
    }
    return true;
  };

  /** Top-level: a real file on disk, read through a partial-read source. */
  const recordFile = (group: GroupAccumulator, displayPath: string, path: string, size: number): void => {
    const src = fileSource(path, size);
    try {
      if (descend && isZipFile(src.read(0, 4))) {
        if (recordZip(group, displayPath, src, 0)) return;
      }

      if (size <= fullReadBytes) {
        const data = src.readAll();
        const key = `${data.length}:${crc32(data)}`;
        if (seenPayloads.has(key)) {
          group.dups++;
          return;
        }
        seenPayloads.add(key);
        recordBytes(group, displayPath, data, 0);
        return;
      }

      // Large file: sample head and tail. The dedupe key is (size, head
      // CRC, tail CRC) — strong, but not a whole-file identity proof;
      // `sampledFiles` records how many verdicts rest on it.
      const head = src.read(0, SAMPLE_BYTES);
      const tail = src.read(size - SAMPLE_BYTES, SAMPLE_BYTES);
      const key = `${size}:${crc32(head)}:${crc32(tail)}~sampled`;
      if (seenPayloads.has(key)) {
        group.dups++;
        return;
      }
      seenPayloads.add(key);
      group.sampled++;
      const info = triageFile(head);
      tally(group, displayPath, size, info.dominantClass, info.isHunk, false);
      for (const hit of info.containers) {
        group.hits++;
        if (group.containers.length < MAX_CONTAINERS_PER_GROUP && storedContainers < MAX_CONTAINERS_TOTAL) {
          group.containers.push({ ...hit, file: `${displayPath} (sampled prefix)` });
          storedContainers++;
        }
      }
    } finally {
      bytesRead += src.bytesRead;
      src.close();
    }
  };

  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (SKIP_FILE.test(name) || st.size === 0 || st.size > maxBytes) continue;
      opts.onFile?.(p);
      fileCount++;
      totalBytes += st.size;
      const rel = relative(root, p);
      // One game per group. In an installed corpus that's the top-level
      // directory; in a collection-shaped one (a flat directory of
      // per-release archives) it's the TOSEC title where the name
      // follows that convention, else the archive's own name.
      const stem = basename(rel, extname(rel));
      const top = rel.includes('/') ? rel.split('/')[0] : (tosecTitle(stem) ?? stem);
      recordFile(groupFor(top), rel, p, st.size);
    }
  };
  walk(root);

  const summaries = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([group, g]) => ({
      group,
      files: g.files,
      bytes: g.bytes,
      extensions: [...g.exts.entries()]
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .map(([ext, e]) => ({
          ext,
          count: e.count,
          bytes: e.bytes,
          hunk: e.hunk,
          adf: e.adf,
          classes: [...e.classes.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([c, n]) => `${c}×${n}`)
            .join(', '),
        })),
      containerHits: g.hits,
      containers: g.containers,
      slaves: g.slaves,
      duplicatesSkipped: g.dups,
      sampledFiles: g.sampled,
    }));

  return {
    root,
    files: fileCount,
    groups: summaries,
    totalBytes,
    bytesRead,
    duplicatesSkipped: summaries.reduce((n, g) => n + g.duplicatesSkipped, 0),
    sampledFiles: summaries.reduce((n, g) => n + g.sampledFiles, 0),
  };
}

// ── CLI ────────────────────────────────────────────────────────────────

export const TRIAGE_USAGE = `seer-probe triage <dir> [--full-read-mb 8] [--max-file-mb <n>] [--no-descend] [--out <dir>]
  First-contact triage of a whole corpus: per top-level subdirectory, an
  extension → dominant-class table, container hits (IFF at any offset,
  MOD, HUNK-wrapped), WHDLoad slave labels, HUNK/ADF detection. Descends
  into ZIPs (reading only the tail to dedupe members by stored CRC before
  decompressing anything) and walkable AmigaDOS ADF filesystems. Files
  over --full-read-mb are sampled head+tail rather than read whole.
  Reports bytes actually read — the cost that matters on a network share.`;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function runTriage(argv: string[]): number {
  const { positional, flags } = parseFlags(argv, {
    'max-file-mb': 'number',
    'full-read-mb': 'number',
    'show': 'number',
    'no-descend': 'bool',
    out: 'string',
  });
  const root = positional[0];
  if (!root) {
    console.error(TRIAGE_USAGE);
    return 1;
  }
  const report = triageDirectory(root, {
    maxFileBytes: flags['max-file-mb'] ? (flags['max-file-mb'] as number) * 1024 * 1024 : undefined,
    fullReadBytes: flags['full-read-mb'] ? (flags['full-read-mb'] as number) * 1024 * 1024 : undefined,
    descend: !(flags['no-descend'] as boolean | undefined),
  });

  // A collection can hold thousands of games; print the largest and
  // leave the rest to the JSON rather than flooding the terminal.
  const show = (flags.show as number | undefined) ?? 40;
  const shown = [...report.groups].sort((a, b) => b.bytes - a.bytes).slice(0, show);
  for (const g of shown) {
    const top = g.extensions
      .slice(0, 3)
      .map((e) => `${e.ext}(${e.count})`)
      .join(' ');
    const adf = g.extensions.reduce((n, e) => n + e.adf, 0);
    const hunk = g.extensions.reduce((n, e) => n + e.hunk, 0);
    const label = g.slaves[0]?.name ? ` "${g.slaves[0].name}"` : '';
    console.log(
      `${g.group.slice(0, 34).padEnd(34)} ${String(g.files).padStart(5)} files ${mb(g.bytes).padStart(10)}  containers:${String(g.containerHits).padStart(4)}` +
        `${hunk ? ` hunk:${hunk}` : ''}${adf ? ` adf:${adf}` : ''}${g.duplicatesSkipped ? ` dup:${g.duplicatesSkipped}` : ''}` +
        `${g.sampledFiles ? ` sampled:${g.sampledFiles}` : ''}  ${top}${label}`,
    );
  }
  if (report.groups.length > shown.length) {
    console.log(`… and ${report.groups.length - shown.length} more groups (full detail in the JSON)`);
  }

  // Corpus rollup: what the whole collection is made of.
  const classTotals = new Map<string, number>();
  const extTotals = new Map<string, { count: number; bytes: number }>();
  let labelled = 0;
  for (const g of report.groups) {
    if (g.slaves.some((s) => s.name)) labelled++;
    for (const e of g.extensions) {
      const acc = extTotals.get(e.ext) ?? { count: 0, bytes: 0 };
      acc.count += e.count;
      acc.bytes += e.bytes;
      extTotals.set(e.ext, acc);
      for (const part of e.classes.split(', ')) {
        if (!part) continue;
        const idx = part.lastIndexOf('×');
        if (idx === -1) continue;
        const cls = part.slice(0, idx);
        classTotals.set(cls, (classTotals.get(cls) ?? 0) + Number(part.slice(idx + 1)));
      }
    }
  }
  console.log(`\n${report.groups.length} groups, ${labelled} with a WHDLoad slave label`);
  console.log(
    'top formats: ' +
      [...extTotals.entries()]
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, 8)
        .map(([ext, v]) => `${ext}(${v.count})`)
        .join(' '),
  );
  console.log(
    'content mix: ' +
      [...classTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([c, n]) => `${c}×${n}`)
        .join(', '),
  );

  const outDir = ensureOutDir(flags.out as string | undefined);
  const jsonPath = artifactPath(outDir, 'triage', root.replace(/\/+$/, ''), '.json');
  writeJson(jsonPath, report);
  const saved = report.totalBytes > 0 ? (100 * (1 - report.bytesRead / report.totalBytes)).toFixed(1) : '0';
  console.log(
    `\n${report.files} disk files triaged, ${report.duplicatesSkipped} exact duplicates skipped` +
      `${report.sampledFiles ? `, ${report.sampledFiles} large files sampled` : ''}.`,
  );
  console.log(`read ${mb(report.bytesRead)} of ${mb(report.totalBytes)} on disk (${saved}% avoided)`);
  console.log(`wrote ${jsonPath}`);
  return 0;
}

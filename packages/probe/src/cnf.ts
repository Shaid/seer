/**
 * `seer-probe cnf <executable>` — IRA config audit and generation.
 *
 * IRA cannot reliably separate code from data and fails in both documented
 * directions: on a large hand-optimized binary `-preproc` declares almost
 * nothing as code; on a small single-CODE-hunk loader it overcorrects the
 * other way. Either way the damage is silent — an under-covering `.cnf`
 * "doesn't error or look broken" and can sit committed as a trusted search
 * surface for multiple sessions.
 *
 * `--audit` turns that silent failure into a one-line measurement:
 * declared-CODE bytes over CODE-hunk **payload** bytes (never file size,
 * which would wrongly count hunk headers, reloc tables and DATA/BSS in
 * the denominator).
 *
 * `--generate` inverts `-preproc`'s approach, per the documented
 * asymmetry: IRA's default pass treats a whole hunk as code and falls
 * back to `DC.W` only where a byte pattern genuinely fails to decode — so
 * over-declaring CODE degrades gracefully while under-declaring fails
 * silently. Therefore: declare whole CODE hunks as code and carve out
 * only high-confidence data islands (long zero runs, string tables as
 * `TEXT`, pointer/jump tables identified by runs of consecutive
 * `HUNK_RELOC32` offsets). `HUNK_SYMBOL` entries are emitted as `SYMBOL`
 * directives — free real names.
 */

import { readFileSync } from 'node:fs';
import {
  codeHunks,
  hunkLoadAddresses,
  isHunkFile,
  parseHunkFile,
  type Hunk,
} from '@seer-project/amiga';
import { readBinary, writeJson } from '@seer-project/pipeline';
import { writeFileSync } from 'node:fs';
import { parseFlags } from './args.js';
import { artifactPath, ensureOutDir } from './out.js';

// ── .cnf parsing ───────────────────────────────────────────────────────

export interface CnfFile {
  offset: number;
  /** Declared CODE ranges, end-exclusive, in the file's own address space. */
  codeRanges: { start: number; end: number }[];
}

/** Parse the directives `--audit` needs out of an IRA `.cnf`. */
export function parseCnf(text: string): CnfFile {
  let offset = 0;
  const codeRanges: { start: number; end: number }[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/;.*/, '').trim();
    let m = /^OFFSET\s+\$([0-9a-f]+)/i.exec(line);
    if (m) offset = parseInt(m[1], 16);
    m = /^CODE\s+\$([0-9a-f]+)\s*-?\s*\$([0-9a-f]+)/i.exec(line);
    if (m) codeRanges.push({ start: parseInt(m[1], 16), end: parseInt(m[2], 16) });
  }
  return { offset, codeRanges };
}

// ── --audit ────────────────────────────────────────────────────────────

export interface HunkCoverage {
  hunkIndex: number;
  address: number;
  payloadBytes: number;
  declaredBytes: number;
  coverage: number;
}

export interface AuditResult {
  file: string;
  cnf: string;
  codeHunks: HunkCoverage[];
  totalPayloadBytes: number;
  totalDeclaredBytes: number;
  /** Declared-CODE bytes over CODE-hunk payload bytes — a measurement, not a hypothesis. */
  coverage: number;
  assessment: string;
  dcx?: { dcLines: number; totalLines: number; ratio: number };
}

/** Audit a `.cnf`'s declared-CODE coverage against the binary's hunk map. */
export function auditCnf(data: Uint8Array, cnfText: string, file: string, cnfPath: string): AuditResult {
  const hunks = parseHunkFile(data);
  const cnf = parseCnf(cnfText);
  const addrs = hunkLoadAddresses(hunks, cnf.offset);

  const perHunk: HunkCoverage[] = [];
  for (const h of codeHunks(hunks)) {
    const addr = addrs[h.index];
    let declared = 0;
    for (const r of cnf.codeRanges) {
      declared += Math.max(0, Math.min(r.end, addr + h.size) - Math.max(r.start, addr));
    }
    perHunk.push({
      hunkIndex: h.index,
      address: addr,
      payloadBytes: h.size,
      declaredBytes: declared,
      coverage: round3(h.size === 0 ? 0 : declared / h.size),
    });
  }

  const totalPayload = perHunk.reduce((s, h) => s + h.payloadBytes, 0);
  const totalDeclared = perHunk.reduce((s, h) => s + h.declaredBytes, 0);
  const coverage = totalPayload === 0 ? 0 : totalDeclared / totalPayload;

  return {
    file,
    cnf: cnfPath,
    codeHunks: perHunk,
    totalPayloadBytes: totalPayload,
    totalDeclaredBytes: totalDeclared,
    coverage: round3(coverage),
    assessment: assess(coverage, perHunk),
  };
}

function assess(coverage: number, perHunk: HunkCoverage[]): string {
  if (coverage >= 0.9) {
    return 'healthy — CODE hunks legitimately embed data, so ~99.5% is the empirical ceiling, not 100%';
  }
  const largest = Math.max(0, ...perHunk.map((h) => h.payloadBytes));
  if (coverage < 0.3 && largest >= 0x8000) {
    return (
      'severely under-declared — matches the documented large-binary failure mode ' +
      '(-preproc declares almost nothing as code on hand-optimized binaries). ' +
      'Any .asm generated from this .cnf with -config is mostly DC.x soup; regenerate with --generate'
    );
  }
  if (coverage < 0.3) {
    return (
      'severely under-declared — matches the documented small-loader failure mode ' +
      '(a mostly-code hunk classified as almost all data). Regenerate with --generate'
    );
  }
  return 'partially declared — treat search misses against the generated .asm as unreliable';
}

/** `DC.x` directive ratio of an IRA `.asm` — the cheap cross-check for misclassified-data soup. */
export function dcxRatio(asmText: string): { dcLines: number; totalLines: number; ratio: number } {
  const lines = asmText.split('\n');
  let dc = 0;
  for (const line of lines) {
    if (/^\s*DC\.[BWL]\b/i.test(line) || /^\S+:?\s+DC\.[BWL]\b/i.test(line)) dc++;
  }
  return { dcLines: dc, totalLines: lines.length, ratio: round3(lines.length === 0 ? 0 : dc / lines.length) };
}

// ── --generate ─────────────────────────────────────────────────────────

export interface DataIsland {
  /** Absolute address (IRA address space). */
  start: number;
  end: number;
  kind: 'zero-run' | 'string-table' | 'pointer-table';
}

export interface GeneratedCnf {
  text: string;
  islands: DataIsland[];
  symbols: number;
  codeHunkCount: number;
}

const MIN_ZERO_RUN = 64;
const MIN_STRING_TABLE = 48;
const MIN_RELOC_RUN = 4;

/** Generate a `.cnf` for a HUNK executable. Pure — no I/O. */
export function generateCnf(data: Uint8Array, opts: { entry?: number; offset?: number } = {}): GeneratedCnf {
  const hunks = parseHunkFile(data);
  const base = opts.offset ?? 0;
  const addrs = hunkLoadAddresses(hunks, base);

  const lines: string[] = ['MACHINE 68000', `ENTRY ${hex(opts.entry ?? 0)}`, `OFFSET ${hex(base)}`];
  const allIslands: DataIsland[] = [];
  let symbolCount = 0;
  const symbolLines: string[] = [];
  const dataLines: string[] = [];
  const textLines: string[] = [];

  const code = codeHunks(hunks);
  for (const h of code) {
    const addr = addrs[h.index];
    const payload = data.subarray(h.fileOffset!, h.fileOffset! + h.size);
    const islands = carveIslands(payload, h).map((i) => ({
      ...i,
      start: i.start + addr,
      end: i.end + addr,
    }));
    allIslands.push(...islands);

    // CODE ranges = whole hunk minus islands. Over-declaring degrades
    // gracefully; the islands are only carved at high confidence.
    let cursor = addr;
    for (const isl of islands) {
      if (isl.start > cursor) lines.push(`CODE ${hex(cursor)} - ${hex(isl.start)}`);
      (isl.kind === 'string-table' ? textLines : dataLines).push(
        `${isl.kind === 'string-table' ? 'TEXT' : 'DATA'} ${hex(isl.start)} - ${hex(isl.end)}\t; ${isl.kind}`,
      );
      cursor = isl.end;
    }
    if (cursor < addr + h.size) lines.push(`CODE ${hex(cursor)} - ${hex(addr + h.size)}`);

    for (const sym of h.symbols) {
      symbolLines.push(`SYMBOL ${sym.name} ${hex(addr + sym.value)}`);
      symbolCount++;
    }
  }

  lines.push(...dataLines, ...textLines, ...symbolLines, 'END', '');
  return { text: lines.join('\n'), islands: allIslands, symbols: symbolCount, codeHunkCount: code.length };
}

/** High-confidence data islands within one CODE hunk payload (offsets hunk-relative, even-aligned). */
export function carveIslands(payload: Uint8Array, hunk: Hunk): DataIsland[] {
  const islands: DataIsland[] = [];

  // Pointer/jump tables: runs of ≥ MIN_RELOC_RUN consecutive relocated
  // longwords (offsets exactly 4 apart). Isolated reloc offsets are NOT
  // data — absolute operands inside instructions are relocated too — but
  // a dense run is a table.
  const relocOffsets = hunk.relocs
    .flatMap((r) => r.offsets)
    .sort((a, b) => a - b);
  let runStart = 0;
  for (let i = 1; i <= relocOffsets.length; i++) {
    if (i === relocOffsets.length || relocOffsets[i] !== relocOffsets[i - 1] + 4) {
      const runLen = i - runStart;
      if (runLen >= MIN_RELOC_RUN) {
        islands.push({ start: relocOffsets[runStart], end: relocOffsets[i - 1] + 4, kind: 'pointer-table' });
      }
      runStart = i;
    }
  }

  // Long zero runs.
  let zeroStart = -1;
  for (let i = 0; i <= payload.length; i++) {
    if (i < payload.length && payload[i] === 0) {
      if (zeroStart === -1) zeroStart = i;
    } else if (zeroStart !== -1) {
      if (i - zeroStart >= MIN_ZERO_RUN) {
        islands.push({ start: (zeroStart + 1) & ~1, end: i & ~1, kind: 'zero-run' });
      }
      zeroStart = -1;
    }
  }

  // String tables: chains of NUL-terminated printable strings. Detected as
  // terminated units, NOT printable runs — 68k opcodes are frequently
  // printable bytes (a NOP sled is "NqNqNq…"), so "mostly printable" would
  // carve real code. A unit is a 4–64-char printable run immediately
  // followed by NUL; two or more units chained (allowing NUL/newline
  // padding between) make a table, emitted as IRA's TEXT directive.
  islands.push(...findStringTables(payload));

  // Sort; on overlap keep the earlier-starting island and drop the other
  // (conservative — carving less keeps the graceful-degradation direction).
  islands.sort((a, b) => a.start - b.start);
  const merged: DataIsland[] = [];
  for (const isl of islands) {
    if (isl.end - isl.start < 16) continue;
    const last = merged[merged.length - 1];
    if (last && isl.start < last.end) continue;
    merged.push(isl);
  }
  return merged;
}

const MIN_STRING_UNIT = 4;
const MAX_STRING_UNIT = 64;

function findStringTables(payload: Uint8Array): DataIsland[] {
  // Units: [start, end) spans of a printable run + its NUL terminator.
  const units: { start: number; end: number }[] = [];
  let runStart = -1;
  for (let i = 0; i <= payload.length; i++) {
    const b = i < payload.length ? payload[i] : -1;
    if (b >= 0x20 && b <= 0x7e) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1 && b === 0x00) {
        const len = i - runStart;
        if (len >= MIN_STRING_UNIT && len <= MAX_STRING_UNIT) units.push({ start: runStart, end: i + 1 });
      }
      runStart = -1;
    }
  }

  const tables: DataIsland[] = [];
  let chainStart = 0;
  for (let i = 1; i <= units.length; i++) {
    const gapOk =
      i < units.length &&
      units[i].start - units[i - 1].end <= 2 &&
      isPadding(payload, units[i - 1].end, units[i].start);
    if (!gapOk) {
      const chain = units.slice(chainStart, i);
      const start = chain[0]?.start ?? 0;
      const end = chain[chain.length - 1]?.end ?? 0;
      if (chain.length >= 2 && end - start >= MIN_STRING_TABLE) {
        tables.push({ start: (start + 1) & ~1, end: end & ~1, kind: 'string-table' });
      }
      chainStart = i;
    }
  }
  return tables;
}

function isPadding(payload: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const b = payload[i];
    if (b !== 0x00 && b !== 0x0a && b !== 0x0d && b !== 0x09) return false;
  }
  return true;
}

// ── CLI ────────────────────────────────────────────────────────────────

export const CNF_USAGE = `seer-probe cnf <executable> (--audit <file.cnf> [--asm <file.asm>] | --generate) [--entry <addr>] [--offset <addr>] [--out <dir>]
  --audit:    measure a .cnf's declared-CODE coverage against the binary's
              CODE-hunk payload bytes (the silent -preproc failure check).
  --generate: emit a .cnf declaring whole CODE hunks as code, carving only
              high-confidence data islands, with SYMBOL directives from
              HUNK_SYMBOL. Pair with IRA -config (and consider -LABEL=1:
              the default numbers labels by discovery order, not address).`;

export function runCnf(argv: string[]): number {
  const { positional, flags } = parseFlags(argv, {
    audit: 'string',
    asm: 'string',
    generate: 'bool',
    entry: 'number',
    offset: 'number',
    out: 'string',
  });
  const file = positional[0];
  if (!file || (!flags.audit && !flags.generate)) {
    console.error(CNF_USAGE);
    return 1;
  }
  const data = readBinary(file);
  if (!isHunkFile(data)) {
    console.error(`cnf: ${file} is not a HUNK executable (no 000003F3 magic)`);
    return 1;
  }
  const outDir = ensureOutDir(flags.out as string | undefined);

  if (flags.audit) {
    const cnfPath = flags.audit as string;
    const result = auditCnf(data, readFileSync(cnfPath, 'utf8'), file, cnfPath);
    if (flags.asm) {
      result.dcx = dcxRatio(readFileSync(flags.asm as string, 'utf8'));
    }
    for (const h of result.codeHunks) {
      console.log(
        `hunk ${h.hunkIndex} CODE at ${hex(h.address)}: ${h.declaredBytes}/${h.payloadBytes} bytes declared (${(h.coverage * 100).toFixed(1)}%)`,
      );
    }
    console.log(
      `overall: ${result.totalDeclaredBytes}/${result.totalPayloadBytes} = ${(result.coverage * 100).toFixed(1)}% of CODE-hunk payload declared as code`,
    );
    if (result.dcx) {
      console.log(
        `asm: ${result.dcx.dcLines}/${result.dcx.totalLines} lines are DC.x (${(result.dcx.ratio * 100).toFixed(1)}%)`,
      );
    }
    console.log(`assessment: ${result.assessment}`);
    const jsonPath = artifactPath(outDir, 'cnf-audit', file, '.json');
    writeJson(jsonPath, result);
    console.log(`wrote ${jsonPath}`);
    return 0;
  }

  const generated = generateCnf(data, {
    entry: flags.entry as number | undefined,
    offset: flags.offset as number | undefined,
  });
  const cnfPath = artifactPath(outDir, 'cnf', file, '.cnf');
  writeFileSync(cnfPath, generated.text);
  const jsonPath = artifactPath(outDir, 'cnf', file, '.json');
  writeJson(jsonPath, {
    file,
    codeHunks: generated.codeHunkCount,
    islands: generated.islands,
    symbols: generated.symbols,
  });
  console.log(
    `${generated.codeHunkCount} CODE hunks declared, ${generated.islands.length} data islands carved, ${generated.symbols} symbols`,
  );
  console.log(`wrote ${cnfPath}`);
  console.log(`wrote ${jsonPath}`);
  console.log('next: ira -config <this .cnf> (and consider -LABEL=1 for address-ordered labels)');
  return 0;
}

function hex(v: number): string {
  return `$${v.toString(16).toUpperCase().padStart(8, '0')}`;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

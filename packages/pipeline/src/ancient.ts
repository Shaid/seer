/**
 * Thin wrapper around the `ancient` CLI (https://github.com/temisu/ancient),
 * used to decompress the retro compression containers several Amiga-era
 * games wrap their files in — RNC ProPack v1/v2 (`RNC\x01`/`RNC\x02`), "IMP!"
 * File Imploder, and PowerPacker/PP20 (including titles that rename the
 * magic, e.g. Jungle Strike AGA's "LR88"). `ancient decompress` auto-detects
 * the container from the input file's own magic bytes, so one code path
 * handles all of them without branching on file extension — except a
 * renamed magic, which has to be patched back before the CLI will recognize
 * it (see `ancientDecompress`'s `magicPatch` option).
 *
 * Node-only by construction: decompression only ever runs in the offline
 * extraction pipeline, never in the browser runtime, so shelling out to an
 * external binary is architecturally fine — the same tradeoff this project
 * already makes for IRA/vasm/xdftool. Requires the `ancient` CLI to be
 * installed and on PATH (or at the path supplied via `ancientPath`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Recognized magic bytes for the containers `ancient` can decompress natively. */
export type AncientContainer = 'rnc1' | 'rnc2' | 'imp' | 'pp20' | 'none';

const MAGICS: Record<Exclude<AncientContainer, 'none'>, number[]> = {
  rnc1: [0x52, 0x4e, 0x43, 0x01], // "RNC\x01"
  rnc2: [0x52, 0x4e, 0x43, 0x02], // "RNC\x02"
  imp: [0x49, 0x4d, 0x50, 0x21], // "IMP!"
  pp20: [0x50, 0x50, 0x32, 0x30], // "PP20"
};

function hasMagic(header: Uint8Array, magic: number[]): boolean {
  return header.length >= magic.length && magic.every((b, i) => header[i] === b);
}

/** Identify which container (if any) a buffer starts with, from its first 4 bytes. */
export function detectAncientContainer(header: Uint8Array): AncientContainer {
  for (const [container, magic] of Object.entries(MAGICS) as [AncientContainer, number[]][]) {
    if (hasMagic(header, magic)) return container;
  }
  return 'none';
}

export interface AncientDecompressOptions {
  /** Path to the `ancient` CLI binary. Defaults to `ancient` (resolved via PATH). */
  ancientPath?: string;
  /**
   * A 4-byte magic to overwrite at offset 0 before shelling out, for
   * containers that rename a standard magic (e.g. Jungle Strike AGA's
   * `LR88`, which is PP20 with the magic renamed). The rest of the file is
   * left untouched. Ignored if omitted.
   */
  magicPatch?: [from: number[], to: number[]];
}

/**
 * Decompress an in-memory buffer via the `ancient` CLI (temp-file round
 * trip). Throws if `ancient` is unavailable or fails to identify/decompress
 * the input.
 */
export function ancientDecompress(data: Uint8Array, options: AncientDecompressOptions = {}): Uint8Array {
  const ancientPath = options.ancientPath ?? 'ancient';
  const dir = mkdtempSync(join(tmpdir(), 'ancient-'));
  const inPath = join(dir, 'in.bin');
  const outPath = join(dir, 'out.raw');

  try {
    let input = data;
    if (options.magicPatch) {
      const [, to] = options.magicPatch;
      input = new Uint8Array(data);
      input.set(to, 0);
    }
    writeFileSync(inPath, input);
    execFileSync(ancientPath, ['decompress', inPath, outPath], { stdio: 'pipe' });
    return new Uint8Array(readFileSync(outPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Decompress `src` into `dst` on disk via the `ancient` CLI, streaming
 * straight through the filesystem rather than round-tripping through
 * memory. Returns the detected container (from `src`'s own magic, before
 * any patch) so callers can log/report what was actually unwrapped.
 */
export function ancientDecompressFile(
  src: string,
  dst: string,
  options: Pick<AncientDecompressOptions, 'ancientPath'> = {},
): AncientContainer {
  const header = readFileSync(src).subarray(0, 4);
  const container = detectAncientContainer(header);
  execFileSync(options.ancientPath ?? 'ancient', ['decompress', src, dst], { stdio: 'pipe' });
  return container;
}

function requireMagic(data: Uint8Array, container: Exclude<AncientContainer, 'none'>, fnName: string): void {
  if (!hasMagic(data, MAGICS[container])) {
    throw new Error(
      `${fnName}: input does not start with the expected magic (got ${Array.from(data.slice(0, 4))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')})`,
    );
  }
}

/** Decompress an RNC1 archive (`data` must start with the `RNC\x01` magic). */
export function decompressRnc1(data: Uint8Array, options: AncientDecompressOptions = {}): Uint8Array {
  requireMagic(data, 'rnc1', 'decompressRnc1');
  return ancientDecompress(data, options);
}

/** Decompress an RNC2 archive (`data` must start with the `RNC\x02` magic). */
export function decompressRnc2(data: Uint8Array, options: AncientDecompressOptions = {}): Uint8Array {
  requireMagic(data, 'rnc2', 'decompressRnc2');
  return ancientDecompress(data, options);
}

/**
 * Decrunch a PowerPacker/PP20-family buffer whose magic has been renamed
 * (e.g. `LR88`), by patching it back to `PP20` before shelling out.
 */
export function decrunchRenamedPp20(
  data: Uint8Array,
  renamedMagic: number[],
  options: AncientDecompressOptions = {},
): Uint8Array {
  if (!hasMagic(data, renamedMagic)) {
    throw new Error(
      `decrunchRenamedPp20: input does not start with the expected renamed magic (got ${Array.from(
        data.slice(0, 4),
      )
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')})`,
    );
  }
  return ancientDecompress(data, { ...options, magicPatch: [renamedMagic, MAGICS.pp20] });
}

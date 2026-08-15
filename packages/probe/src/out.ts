/**
 * Output-path handling shared by every probe command.
 *
 * Default `--out` is a temp scratch directory, NOT the working tree —
 * probes are hypotheses and stay uncommitted by default, matching the
 * existing convention for throwaway hypothesis scripts. Pass `--out` to
 * keep artifacts somewhere deliberate.
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export function defaultOutDir(): string {
  return process.env.SEER_PROBE_OUT ?? join(tmpdir(), 'seer-probe');
}

/** Resolve and create the output directory for a run. */
export function ensureOutDir(out: string | undefined): string {
  const dir = out ?? defaultOutDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `<out>/probe-<cmd>-<name><suffix>` — the shared artifact naming scheme. */
export function artifactPath(outDir: string, cmd: string, inputFile: string, suffix: string): string {
  const name = basename(inputFile).replace(/[^A-Za-z0-9._-]/g, '_');
  return join(outDir, `probe-${cmd}-${name}${suffix}`);
}

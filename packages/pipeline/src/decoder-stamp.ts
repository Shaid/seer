/**
 * The Node half of the decoder-stamp contract whose shapes live in
 * `manifest-types.ts`: read, test and record the stamp that produced a
 * stage's rows in an output directory's manifest.
 *
 * `openCheckpoint`'s `stamp` option already stops a *resume log* from
 * carrying stale work across a decoder fix, but a resume log is only half of
 * what makes an extraction stage skip work. The other half is the manifest
 * itself: nearly every stage reads back the rows it wrote last time and
 * treats "a row with this name already exists" as "already produced, don't
 * redo". Clear only the resume log after a decoder fix and the stage walks
 * the whole corpus again and writes nothing — which is exactly what happened
 * to the project this was built for, twice, each time costing a day of
 * believing a rebuild had happened when it hadn't.
 *
 * So the two guards need the same key. A stage asks
 * {@link manifestStampMatches} before trusting its prior rows, opens its
 * checkpoint with the same stamp, and calls {@link recordDecoderStamp} once
 * it has written the manifest out.
 *
 * Deliberately not part of `writeShardedManifest`: plenty of stages write a
 * flat `manifest.json` and never shard it, sharding often happens in a
 * different stage from the one that decoded anything, and the stamp is about
 * row *provenance* rather than row *layout*.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DECODER_STAMP_FILE, type DecoderStampFile } from './manifest-types.js';

export { DECODER_STAMP_FILE, type DecoderStampFile } from './manifest-types.js';

/**
 * Every stage stamp recorded in `outDir`. An absent, unreadable or
 * malformed sidecar reads as `{}` rather than throwing — the file is a cache
 * key, and the safe reading of "I can't tell" is "nothing is stamped", which
 * costs a rebuild instead of shipping stale output.
 */
export function readDecoderStamps(outDir: string): Record<string, string> {
  const path = resolve(outDir, DECODER_STAMP_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const stages = (raw as DecoderStampFile | null)?.stages;
    if (!stages || typeof stages !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [stage, stamp] of Object.entries(stages)) {
      if (typeof stamp === 'string') out[stage] = stamp;
    }
    return out;
  } catch {
    return {};
  }
}

/** The stamp recorded for one stage, or `undefined` when that stage has never been stamped. */
export function readDecoderStamp(outDir: string, stage: string): string | undefined {
  return readDecoderStamps(outDir)[stage];
}

/**
 * Can this stage's existing manifest rows be trusted as having come from
 * `stamp`? False for a stage that was never stamped — see
 * {@link DecoderStampFile} for why unstamped is treated as stale.
 */
export function manifestStampMatches(outDir: string, stage: string, stamp: string): boolean {
  return readDecoderStamp(outDir, stage) === stamp;
}

/**
 * Record `stamp` as the producer of `stage`'s rows, leaving every other
 * stage's entry alone (stages share one output directory and run in any
 * order, so this must never be a whole-file overwrite).
 */
export function recordDecoderStamp(outDir: string, stage: string, stamp: string): void {
  const stages = { ...readDecoderStamps(outDir), [stage]: stamp };
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(stages).sort()) sorted[key] = stages[key]!;
  writeFileSync(resolve(outDir, DECODER_STAMP_FILE), `${JSON.stringify({ stages: sorted }, null, 2)}\n`);
}

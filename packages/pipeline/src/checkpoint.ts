/**
 * Unit-level resumability for a long extraction stage: a file recording which
 * work units a previous run finished, read back at startup so a re-run skips
 * them.
 *
 * `runPipeline` already tolerates a failing *step*; this is the layer below
 * it. A stage that decodes a hundred thousand archive entries over an hour
 * needs to survive being interrupted, and the shape that need takes is always
 * the same read-set / skip-done / write-set-after-each-unit loop. Before this
 * existed, the consuming project wrote it by hand once per stage — thirteen
 * copies in one project alone, which had already drifted on both the file
 * suffix and the flush cadence.
 *
 * **The on-disk format is deliberately dumb and is a compatibility
 * contract:** `JSON.stringify` of the set in insertion order, nothing else —
 * no header, no version, no metadata. That is what the hand-rolled copies
 * wrote, so every checkpoint file already sitting in a project's output tree
 * keeps resuming after adopting this. A corrupt or unreadable file is treated
 * as "nothing done yet" rather than throwing, because the alternative is a
 * stage that can never start again without manual intervention.
 *
 * **Flush cadence stays the caller's business.** `add()` only touches memory,
 * `flush()` writes, and `mark()` is the add-then-write shorthand. Stages that
 * batch (every 200th unit, say) keep batching; stages that write per unit keep
 * writing per unit. Nothing here silently changes how often a stage hits the
 * disk — picking that trade-off (crash granularity against write amplification
 * on a checkpoint file that grows to tens of thousands of keys) needs to know
 * what a unit costs, which only the stage does.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A set of finished unit keys, backed by a file. `T` is whatever identifies a
 * unit to the stage — an archive index (`number`) or a data-relative path
 * (`string`); both survive the JSON round trip unchanged.
 */
export interface Checkpoint<T extends string | number> {
  /** Did a previous run (or this one) already finish `key`? */
  has(key: T): boolean;
  /** Record `key` in memory only. */
  add(key: T): void;
  /** Record `key` and write the checkpoint out. */
  mark(key: T): void;
  /** Write the checkpoint out now. A no-op when opened with `persist: false`. */
  flush(): void;
  /** How many keys are recorded. */
  readonly size: number;
}

export interface CheckpointOptions {
  /**
   * Read the existing file (default `true`). `false` starts from an empty set
   * — what a stage's `--force` does — while still writing the finished set out.
   */
  load?: boolean;
  /**
   * Write on `mark()`/`flush()` (default `true`). `false` makes the checkpoint
   * purely in-memory, for a partial run (`--only <subset>`) whose result must
   * not be mistaken for a complete one and so must not overwrite the real
   * file.
   */
  persist?: boolean;
}

/**
 * Open `<outDir>/<filename>` as a checkpoint.
 *
 * `filename` is passed through verbatim rather than normalised or given a
 * conventional extension: existing files on disk are real build state, and a
 * stage that has been writing `.audioProgress.json` for a year must keep
 * finding it. Pass the stage's own name (`.progress`, `.meshProgress`, …).
 */
export function openCheckpoint<T extends string | number>(
  outDir: string,
  filename: string,
  opts: CheckpointOptions = {},
): Checkpoint<T> {
  const path = resolve(outDir, filename);
  const persist = opts.persist ?? true;
  let keys: T[] = [];
  if ((opts.load ?? true) && existsSync(path)) {
    try {
      keys = JSON.parse(readFileSync(path, 'utf8')) as T[];
    } catch {
      keys = [];
    }
  }
  const set = new Set<T>(keys);
  const flush = (): void => {
    if (persist) writeFileSync(path, JSON.stringify([...set]));
  };
  return {
    has: (key) => set.has(key),
    add: (key) => {
      set.add(key);
    },
    mark: (key) => {
      set.add(key);
      flush();
    },
    flush,
    get size() {
      return set.size;
    },
  };
}

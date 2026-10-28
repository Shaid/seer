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
 * **Stamping (opt-in, {@link CheckpointOptions.stamp}) is the one extension
 * to that format,** for the stage whose work units are only as good as the
 * decoder that produced them. "Done" means "done *by some version of the
 * code*", and a checkpoint that cannot say which version silently survives a
 * decoder fix: the re-run skips every unit and the outputs stay stale. A
 * stamped checkpoint writes `{"stamp":"…","keys":[…]}` instead of the bare
 * array, and on open with a stamp that disagrees — or with no recorded stamp
 * at all — it reports itself empty, so the stage redoes the work. Reading
 * accepts both shapes in both directions: an unstamped open of a stamped
 * file resumes from its keys, and a stamped open of a legacy array sees the
 * keys it has to decide about. Only a stage that passes `stamp` ever writes
 * the object form, so every other checkpoint in a project stays
 * byte-identical.
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
  /**
   * The stamp the file on disk carried when it was opened: a string for a
   * stamped checkpoint, `undefined` for the bare-array format. Independent
   * of whether it matched — read {@link invalidated} for that.
   */
  readonly priorStamp: string | undefined;
  /**
   * How many keys were thrown away at open because the file's stamp did not
   * match the one passed in. `0` whenever the stamp matched, no stamp was
   * passed, or there was nothing on disk — so a non-zero value always means
   * real cached work is about to be redone, which is worth a log line.
   */
  readonly invalidated: number;
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
  /**
   * An opaque identity for the code that produces this stage's outputs —
   * typically a decoder-revision string like `"bc3.g1t2"`. Pass it and the
   * checkpoint becomes self-invalidating:
   *
   * | on disk | behaviour |
   * |---|---|
   * | same stamp | resumes normally |
   * | different stamp | **starts empty**, {@link Checkpoint.invalidated} counts what was dropped |
   * | no stamp (legacy bare array) | **starts empty**, likewise |
   * | nothing | starts empty, as always |
   *
   * Either way the next write records the new stamp, so the invalidation
   * happens exactly once.
   *
   * Treating *unstamped* as stale is the deliberately conservative half, and
   * it is the only safe default: an unstamped file is a file whose decoder
   * provenance nobody recorded, which is precisely the situation the stamp
   * exists to end. The cost of being wrong in that direction is a rebuild;
   * the cost of being wrong in the other is shipping bad pixels that no
   * re-run will ever fix. A project with existing caches it *knows* are
   * current should adopt them explicitly — rewrite the files with the
   * current stamp once, after whatever freshness check it can actually
   * justify — rather than have this function guess on its behalf.
   */
  stamp?: string;
}

/**
 * Open `<outDir>/<filename>` as a checkpoint.
 *
 * `filename` is passed through verbatim rather than normalised or given a
 * conventional extension: existing files on disk are real build state, and a
 * stage that has been writing `.audioProgress.json` for a year must keep
 * finding it. Pass the stage's own name (`.progress`, `.meshProgress`, …).
 *
 * Pass {@link CheckpointOptions.stamp} for a stage whose cached work is only
 * valid for one revision of a decoder; see that option for the invalidation
 * rule.
 */
export function openCheckpoint<T extends string | number>(
  outDir: string,
  filename: string,
  opts: CheckpointOptions = {},
): Checkpoint<T> {
  const path = resolve(outDir, filename);
  const persist = opts.persist ?? true;
  const stamp = opts.stamp;
  let keys: T[] = [];
  let priorStamp: string | undefined;
  if ((opts.load ?? true) && existsSync(path)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(raw)) {
        keys = raw as T[];
      } else if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { keys?: unknown }).keys)) {
        // The stamped form. Read it even when this caller passed no stamp:
        // a stage can be run by a tool that doesn't know about stamping, and
        // it should still resume rather than redo an hour of work.
        const obj = raw as { stamp?: unknown; keys: T[] };
        keys = obj.keys;
        if (typeof obj.stamp === 'string') priorStamp = obj.stamp;
      }
    } catch {
      keys = [];
    }
  }

  // Invalidation is a load-time decision, so a stage sees `size === 0` and
  // simply redoes its units — no stage needs to know stamping exists beyond
  // passing the option.
  let invalidated = 0;
  if (stamp !== undefined && priorStamp !== stamp && keys.length > 0) {
    invalidated = keys.length;
    keys = [];
  }

  const set = new Set<T>(keys);
  const flush = (): void => {
    if (!persist) return;
    writeFileSync(path, stamp === undefined ? JSON.stringify([...set]) : JSON.stringify({ stamp, keys: [...set] }));
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
    priorStamp,
    invalidated,
  };
}

/**
 * The *contract* half of manifest sharding: the shapes
 * {@link writeShardedManifest} writes and a viewer reads, split out from the
 * writer so a browser can have them.
 *
 * `manifest-sharding.ts` opens with `import { mkdirSync } from 'node:fs'`,
 * and this package's barrel re-exports `config.js` and `io.js`, which also
 * reach for `node:fs` — so a viewer that wanted `CategoryIndexEntry` could
 * not import it from anywhere, and the consuming projects re-declared it by
 * hand instead. Nothing then enforced that the two copies agreed: a field
 * added on the writer side silently did not reach the reader's type. This
 * module exists so there is exactly one declaration, reachable from both
 * sides, and is therefore held to one rule:
 *
 * **Zero imports, no runtime behaviour beyond a constant.** Everything here
 * must stay erasable or inert, because the whole point is that
 * `@seer-project/pipeline/manifest-types` is safe in a browser bundle.
 * Anything that needs `node:*` belongs in `manifest-sharding.ts`.
 *
 * Available two ways: from the package barrel (Node consumers, which already
 * pull in `node:fs` via the rest of it) and from the
 * `@seer-project/pipeline/manifest-types` subpath (browser consumers).
 */

/**
 * The minimum an entry must carry to be shardable. A project's own manifest
 * row type extends this with whatever else it writes; `category` and `group`
 * are the only two fields the sharder itself looks at.
 */
export interface ShardableEntry {
  name: string;
  category?: string;
  group?: string;
}

/** One `group` row within a category that got group-level sub-sharding (see {@link GROUP_SHARD_THRESHOLD}). */
export interface GroupIndexEntry {
  /** Machine id — also the sub-shard filename stem (`manifest/<category>/<id>.json`). */
  id: string;
  count: number;
}

/** One row of `categories.json` — the lightweight index a viewer fetches before committing to any per-category shard fetch. */
export interface CategoryIndexEntry {
  /** Machine id — also the shard filename stem (`manifest/<id>.json`, always written regardless of `groups`). */
  id: string;
  /** Human label; the viewer falls back to `id` itself when absent. */
  displayName?: string;
  /** Total entries in this category (all types combined). */
  count: number;
  /**
   * Present only when this category exceeded `GROUP_SHARD_THRESHOLD` and
   * was additionally split by `group` into `manifest/<category>/<group>
   * .json` sub-shards, sorted largest-first. A viewer can use this to offer
   * a cheaper group-level fetch instead of the (potentially very large)
   * flat `manifest/<id>.json` — both are always written, so either
   * contract works: a viewer unaware of `groups` still gets a correct,
   * complete flat shard.
   */
  groups?: GroupIndexEntry[];
}

/**
 * A category above this many entries also gets split further by `group`
 * (`manifest/<category>/<group>.json`, one file per distinct `group`
 * value) — the flat `manifest/<category>.json` is still written too, this
 * is a purely additive faster path for the (typically one or two) huge
 * categories where even one level of category splitting isn't enough on
 * its own. Picked empirically from a real corpus (a UE3 asset extraction
 * where the dominant `background` category was ~91% of the whole manifest
 * and still ~22MB after category-level splitting alone) — a reasonable
 * general default, not a hard rule; a project may want its own threshold
 * for a very different corpus shape.
 *
 * Exported because a viewer reading `categories.json` has to reason about
 * the same boundary to know when a `groups` array can be expected.
 */
export const GROUP_SHARD_THRESHOLD = 3000;

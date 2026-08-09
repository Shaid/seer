/**
 * Splits an already-built flat `manifest.json` into per-category shards
 * plus a lightweight top-level index, so a viewer can present category
 * navigation and fetch one shard lazily instead of the whole manifest on
 * every page load.
 *
 * Generic/project-agnostic: this file has zero game-specific logic. The
 * categorization itself (deciding what `category`/`group` each entry gets)
 * is always a per-project concern — some projects need a real taxonomy
 * derived from corpus frequency analysis, others can just reuse an
 * existing field like `type` — and stays in that project's own `tools/`,
 * passed in already applied to each entry.
 *
 * Purely additive to the existing single-manifest contract: this writes
 * *new* files (`manifest/<category>.json`, `categories.json`) alongside
 * whatever the caller already writes to `manifest.json` — it never reads
 * or replaces `manifest.json` itself, so a viewer that only knows the
 * single-file contract keeps working unmodified for a project that never
 * calls this.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJson } from './io.ts';

export interface ShardableEntry {
  name: string;
  category?: string;
  group?: string;
}

/** One `group` row within a category that got group-level sub-sharding (see `GROUP_SHARD_THRESHOLD`). */
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
 */
const GROUP_SHARD_THRESHOLD = 3000;

/**
 * Writes `<outDir>/manifest/<category>.json` (one array of entries per
 * distinct `category` value present in `entries`) and `<outDir>/
 * categories.json` (the index, sorted largest-first). Entries with no
 * `category` set fall into an `"uncategorized"` shard rather than being
 * silently dropped. Categories over `GROUP_SHARD_THRESHOLD` also get
 * `manifest/<category>/<group>.json` sub-shards (see `GroupIndexEntry`).
 */
export function writeShardedManifest<T extends ShardableEntry>(
  outDir: string,
  entries: T[],
  displayNames: Record<string, string> = {},
): CategoryIndexEntry[] {
  const manifestDir = resolve(outDir, 'manifest');
  mkdirSync(manifestDir, { recursive: true });

  const byCategory = new Map<string, T[]>();
  for (const entry of entries) {
    const category = entry.category ?? 'uncategorized';
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(entry);
    else byCategory.set(category, [entry]);
  }

  const index: CategoryIndexEntry[] = [];
  for (const [category, items] of byCategory) {
    writeJson(resolve(manifestDir, `${category}.json`), items);
    const indexEntry: CategoryIndexEntry = { id: category, displayName: displayNames[category], count: items.length };

    if (items.length > GROUP_SHARD_THRESHOLD) {
      const byGroup = new Map<string, T[]>();
      for (const item of items) {
        const group = item.group ?? 'ungrouped';
        const bucket = byGroup.get(group);
        if (bucket) bucket.push(item);
        else byGroup.set(group, [item]);
      }
      const groupDir = resolve(manifestDir, category);
      mkdirSync(groupDir, { recursive: true });
      const groups: GroupIndexEntry[] = [];
      for (const [group, groupItems] of byGroup) {
        writeJson(resolve(groupDir, `${group}.json`), groupItems);
        groups.push({ id: group, count: groupItems.length });
      }
      groups.sort((a, b) => b.count - a.count);
      indexEntry.groups = groups;
    }

    index.push(indexEntry);
  }
  index.sort((a, b) => b.count - a.count);

  writeJson(resolve(outDir, 'categories.json'), index);
  return index;
}

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
import { writeJson } from './io.js';

import {
  GROUP_SHARD_THRESHOLD,
  type CategoryIndexEntry,
  type GroupIndexEntry,
  type ShardableEntry,
} from './manifest-types.js';

/**
 * The shapes written here live in `manifest-types.ts` so a browser-side
 * viewer can import them from `@seer-project/pipeline/manifest-types`
 * without this module's `node:fs` coming along. Re-exported from here — and
 * so, unchanged, from the package barrel — because every Node-side caller
 * already reaches for them through the writer.
 */
export * from './manifest-types.js';

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
    const indexEntry: CategoryIndexEntry = {
      id: category,
      displayName: displayNames[category],
      count: items.length,
    };

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

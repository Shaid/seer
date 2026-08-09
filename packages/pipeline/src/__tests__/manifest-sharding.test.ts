import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeShardedManifest } from '../manifest-sharding.js';

describe('writeShardedManifest', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'seer-shard-test-'));
    dirs.push(d);
    return d;
  }

  it('writes one shard per distinct category and a sorted index', () => {
    const outDir = tmp();
    const entries = [
      { name: 'a', category: 'background' },
      { name: 'b', category: 'background' },
      { name: 'c', category: 'character' },
    ];

    const index = writeShardedManifest(outDir, entries, {
      background: 'Backgrounds',
      character: 'Characters',
    });

    expect(index).toEqual([
      { id: 'background', displayName: 'Backgrounds', count: 2 },
      { id: 'character', displayName: 'Characters', count: 1 },
    ]);

    const indexOnDisk = JSON.parse(readFileSync(resolve(outDir, 'categories.json'), 'utf-8'));
    expect(indexOnDisk).toEqual(index);

    const bgShard = JSON.parse(
      readFileSync(resolve(outDir, 'manifest', 'background.json'), 'utf-8'),
    );
    expect(bgShard).toEqual([entries[0], entries[1]]);

    const charShard = JSON.parse(
      readFileSync(resolve(outDir, 'manifest', 'character.json'), 'utf-8'),
    );
    expect(charShard).toEqual([entries[2]]);
  });

  it('buckets entries with no category into "uncategorized" rather than dropping them', () => {
    const outDir = tmp();
    const entries = [{ name: 'a' }, { name: 'b', category: 'ui' }];

    const index = writeShardedManifest(outDir, entries);
    const ids = index.map((i) => i.id).sort();
    expect(ids).toEqual(['ui', 'uncategorized']);
    expect(existsSync(resolve(outDir, 'manifest', 'uncategorized.json'))).toBe(true);
  });

  it('omits displayName when none was provided for a category', () => {
    const outDir = tmp();
    const index = writeShardedManifest(outDir, [{ name: 'a', category: 'x' }]);
    expect(index).toEqual([{ id: 'x', displayName: undefined, count: 1 }]);
  });

  it('also writes group sub-shards and a groups[] index for a category above the threshold', () => {
    const outDir = tmp();
    // 3001 entries in one category, split across two groups, exceeds the 3000-entry GROUP_SHARD_THRESHOLD.
    const entries = [
      ...Array.from({ length: 2000 }, (_, i) => ({
        name: `bg30-${i}`,
        category: 'background',
        group: 'BG30',
      })),
      ...Array.from({ length: 1001 }, (_, i) => ({
        name: `bg50-${i}`,
        category: 'background',
        group: 'BG50',
      })),
    ];

    const index = writeShardedManifest(outDir, entries);
    expect(index).toHaveLength(1);
    const bg = index[0]!;
    expect(bg.count).toBe(3001);
    expect(bg.groups).toEqual([
      { id: 'BG30', count: 2000 },
      { id: 'BG50', count: 1001 },
    ]);

    // The flat shard is still written in full, for a client unaware of groups.
    const flat = JSON.parse(readFileSync(resolve(outDir, 'manifest', 'background.json'), 'utf-8'));
    expect(flat).toHaveLength(3001);

    // Group sub-shards are real and independently fetchable.
    const bg30 = JSON.parse(
      readFileSync(resolve(outDir, 'manifest', 'background', 'BG30.json'), 'utf-8'),
    );
    expect(bg30).toHaveLength(2000);
    const bg50 = JSON.parse(
      readFileSync(resolve(outDir, 'manifest', 'background', 'BG50.json'), 'utf-8'),
    );
    expect(bg50).toHaveLength(1001);
  });

  it('does not add groups[] for a category at or below the threshold', () => {
    const outDir = tmp();
    const entries = Array.from({ length: 3000 }, (_, i) => ({
      name: `x${i}`,
      category: 'ui',
      group: 'HUD',
    }));
    const index = writeShardedManifest(outDir, entries);
    expect(index[0]!.groups).toBeUndefined();
    expect(existsSync(resolve(outDir, 'manifest', 'ui'))).toBe(false);
  });

  it('falls entries with no group into "ungrouped" within a group-sharded category', () => {
    const outDir = tmp();
    const entries = Array.from({ length: 3001 }, (_, i) => ({
      name: `x${i}`,
      category: 'background',
    }));
    const index = writeShardedManifest(outDir, entries);
    expect(index[0]!.groups).toEqual([{ id: 'ungrouped', count: 3001 }]);
  });
});

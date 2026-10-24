import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GROUP_SHARD_THRESHOLD } from '../manifest-types.js';
import * as sharding from '../manifest-sharding.js';
import * as barrel from '../index.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../manifest-types.ts', import.meta.url)), 'utf8');

describe('manifest-types', () => {
  // The entire reason this module was split out of manifest-sharding.ts: a
  // browser viewer imports `@seer-project/pipeline/manifest-types` and must
  // not drag in `node:fs`. The subpath can only stay browser-safe if the
  // module imports nothing at all, so assert that directly on the source
  // rather than trusting review — a single added `import` here silently
  // breaks every consuming viewer's bundle, not this package's own tests.
  it('imports nothing, so the subpath is safe in a browser bundle', () => {
    const imports = SOURCE.match(/^\s*(?:import|export)\s.*\bfrom\s/gm) ?? [];
    expect(imports).toEqual([]);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
  });

  it('is the single declaration — the writer and the barrel re-export it', () => {
    expect(sharding.GROUP_SHARD_THRESHOLD).toBe(GROUP_SHARD_THRESHOLD);
    expect(barrel.GROUP_SHARD_THRESHOLD).toBe(GROUP_SHARD_THRESHOLD);
  });

  // Not an arbitrary number to re-pick: a viewer reading `categories.json`
  // uses the same boundary to know when a `groups` array can be expected, so
  // changing it changes a published contract, not just a heuristic.
  it('keeps the group sub-shard threshold at its documented value', () => {
    expect(GROUP_SHARD_THRESHOLD).toBe(3000);
  });
});

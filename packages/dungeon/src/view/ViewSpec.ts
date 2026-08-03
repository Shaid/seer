/**
 * The geometry parameters `buildViewList` needs, independent of any
 * particular `SlotTableFile` instance (so a caller building its own poses
 * in a test doesn't have to construct a full slot table just to get these
 * three numbers). Mirrors `SlotTableFile`'s own matching fields exactly —
 * `viewSpecFromSlotTable` below derives one from the other so the two never
 * drift apart in a real caller.
 */
import type { SlotTableFile } from '../schema/slots.ts';

export interface ViewSpec {
  /** Number of depths visited, 0 (nearest) through `depthCount - 1` (farthest). */
  depthCount: number;
  /** Lateral offsets visited at each depth (Black Crypt: `[0, 1, -1]`, centre-first). */
  lateralOffsets: number[];
  /** Front walls are only ever tested for `depth < frontWallMaxDepth` (Black Crypt: 3). */
  frontWallMaxDepth: number;
}

export function viewSpecFromSlotTable(table: SlotTableFile): ViewSpec {
  return {
    depthCount: table.depthCount,
    lateralOffsets: table.lateralOffsets,
    frontWallMaxDepth: table.frontWallMaxDepth,
  };
}

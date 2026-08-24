import { describe, expect, it } from 'vitest';
import { AutomapState } from '../automap/AutomapState.js';

const sizeOf = () => ({ width: 4, height: 4 });

describe('AutomapState', () => {
  it('marks a cell visited only once onEnterCell is called for it, not on construction', () => {
    const state = new AutomapState(sizeOf);
    expect(state.isVisited(1, 2, 2)).toBe(false);
    state.onEnterCell(1, 2, 2);
    expect(state.isVisited(1, 2, 2)).toBe(true);
    // A neighbouring, never-entered cell stays unvisited.
    expect(state.isVisited(1, 2, 3)).toBe(false);
  });

  it('is idempotent: entering the same cell twice does not change visitedCount', () => {
    const state = new AutomapState(sizeOf);
    state.onEnterCell(1, 0, 0);
    state.onEnterCell(1, 0, 0);
    expect(state.visitedCount(1)).toBe(1);
  });

  it('tracks units independently', () => {
    const state = new AutomapState(sizeOf);
    state.onEnterCell(1, 0, 0);
    state.onEnterCell(2, 0, 0);
    state.onEnterCell(2, 1, 1);
    expect(state.visitedCount(1)).toBe(1);
    expect(state.visitedCount(2)).toBe(2);
  });

  it('visitedCells lists exactly the entered cells', () => {
    const state = new AutomapState(sizeOf);
    state.onEnterCell(1, 0, 0);
    state.onEnterCell(1, 3, 2);
    const cells = state.visitedCells(1).sort((a, b) => a.x - b.x || a.y - b.y);
    expect(cells).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 2 },
    ]);
  });

  it('rejects an out-of-bounds x that would otherwise wrap into the next row (finding: flattened-index bounds check)', () => {
    const state = new AutomapState(sizeOf); // width 4, height 4
    state.onEnterCell(1, 4, 0); // x === width: out of bounds, not row (0,1)
    expect(state.isVisited(1, 0, 1)).toBe(false); // did not corrupt the next row
    expect(state.isVisited(1, 4, 0)).toBe(false); // and the out-of-bounds cell itself reads back false
    expect(state.visitedCount(1)).toBe(0);
  });

  it('rejects negative and out-of-bounds y the same way', () => {
    const state = new AutomapState(sizeOf); // width 4, height 4
    state.onEnterCell(1, 0, -1);
    state.onEnterCell(1, 0, 4);
    state.onEnterCell(1, -1, 0);
    expect(state.visitedCount(1)).toBe(0);
    expect(state.isVisited(1, -1, 0)).toBe(false);
  });

  it('serialize/restore round-trips visited state', () => {
    const state = new AutomapState(sizeOf);
    state.onEnterCell(1, 1, 1);
    state.onEnterCell(1, 2, 2);
    const snapshot = state.serialize();

    const restored = new AutomapState(sizeOf);
    restored.restore(snapshot);
    expect(restored.isVisited(1, 1, 1)).toBe(true);
    expect(restored.isVisited(1, 2, 2)).toBe(true);
    expect(restored.isVisited(1, 0, 0)).toBe(false);
    expect(restored.visitedCount(1)).toBe(2);
  });
});

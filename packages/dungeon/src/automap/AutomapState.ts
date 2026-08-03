/**
 * Per-unit visited-cell tracking (fog of war). Fed by the host's own
 * movement loop via `onEnterCell` every time a `Pose` moves to a new cell —
 * *not* on every render, so a cell that's merely visible in the current view
 * (or drawn once for a screenshot) never counts as "visited" on its own.
 *
 * Deliberately doesn't read a level itself — `CellQuery` stays the single
 * read path for geometry (per the walker plan's automap section); this class
 * is a decorator holding *state* (what's been seen), not a second way to
 * query cells.
 */
export interface CellSize {
  width: number;
  height: number;
}

export class AutomapState {
  private readonly sizeOf: (unitId: number) => CellSize;
  private readonly bitsets = new Map<number, Uint8Array>();
  private readonly widths = new Map<number, number>();

  constructor(sizeOf: (unitId: number) => CellSize) {
    this.sizeOf = sizeOf;
  }

  private bitsetFor(unitId: number): { bits: Uint8Array; width: number } {
    let bits = this.bitsets.get(unitId);
    if (!bits) {
      const { width, height } = this.sizeOf(unitId);
      bits = new Uint8Array(width * height);
      this.bitsets.set(unitId, bits);
      this.widths.set(unitId, width);
    }
    return { bits, width: this.widths.get(unitId)! };
  }

  /** Mark `(x, y)` in `unitId` as visited. Idempotent — entering an already-visited cell again is a no-op. */
  onEnterCell(unitId: number, x: number, y: number): void {
    const { bits, width } = this.bitsetFor(unitId);
    const idx = y * width + x;
    if (idx >= 0 && idx < bits.length) bits[idx] = 1;
  }

  isVisited(unitId: number, x: number, y: number): boolean {
    const { bits, width } = this.bitsetFor(unitId);
    const idx = y * width + x;
    return idx >= 0 && idx < bits.length && bits[idx] === 1;
  }

  /** Every visited `(x, y)` in `unitId`, in no particular order. */
  visitedCells(unitId: number): Array<{ x: number; y: number }> {
    const { bits, width } = this.bitsetFor(unitId);
    const out: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) out.push({ x: i % width, y: Math.floor(i / width) });
    }
    return out;
  }

  visitedCount(unitId: number): number {
    const { bits } = this.bitsetFor(unitId);
    let n = 0;
    for (const b of bits) if (b) n++;
    return n;
  }

  /** A JSON-safe snapshot, per unit, of which cells have been visited — round-trippable via `restore`. */
  serialize(): Record<number, { width: number; visited: number[] }> {
    const out: Record<number, { width: number; visited: number[] }> = {};
    for (const [unitId, bits] of this.bitsets) {
      const visited: number[] = [];
      for (let i = 0; i < bits.length; i++) if (bits[i]) visited.push(i);
      out[unitId] = { width: this.widths.get(unitId)!, visited };
    }
    return out;
  }

  /** Restores state written by `serialize()`, replacing whatever this instance currently holds for each named unit. */
  restore(data: Record<number, { width: number; visited: number[] }>): void {
    for (const [unitIdStr, snapshot] of Object.entries(data)) {
      const unitId = Number(unitIdStr);
      const { width, height } = this.sizeOf(unitId);
      if (snapshot.width !== width) {
        throw new Error(`AutomapState.restore: unit ${unitId} width mismatch (snapshot ${snapshot.width}, expected ${width})`);
      }
      const bits = new Uint8Array(width * height);
      for (const idx of snapshot.visited) bits[idx] = 1;
      this.bitsets.set(unitId, bits);
      this.widths.set(unitId, width);
    }
  }
}

/**
 * Validator for the `{verts, faces}` mesh shape a build step is about to
 * serialize as polygon-json.
 *
 * These checks exist because a wrong format hypothesis is silent by default:
 * `JSON.stringify(NaN)` is `null`, and an out-of-range face index is just a
 * number. Both produce a file that looks fine and renders as nothing. Real
 * bugs have shipped this way — a byte-length read as an element count in a
 * CGFX index buffer, and un-rebased absolute indices in an MT Framework MOD
 * export — so this reports them at build time instead.
 *
 * `PolygonObject` here is deliberately its own type, not `PolygonModel` from
 * `./types.js`: this package's `PolygonModel` carries `edges`/`typeTag`
 * fields this validator has no use for, and a narrower `stats` shape than
 * some hosts produce. Writing the validated object to disk and tallying
 * per-build stats are host concerns and stay with the caller.
 */
import type { PolygonFace } from './types.js';

export type { PolygonFace };

export interface PolygonObject {
  id: number;
  name: string;
  verts: number[][];
  faces: PolygonFace[];
  stats: { vertices: number; triangles: number };
}

export interface PolygonModelIssues {
  /** Coordinates that are NaN or ±Infinity (would serialise to JSON `null`). */
  nonFiniteVerts: number;
  /** Face indices outside `[0, verts.length)`. */
  outOfRangeIndices: number;
  /** Objects whose coordinates exceed `MAX_COORD`. */
  implausibleExtents: number;
}

/**
 * Largest plausible coordinate magnitude. Some source games genuinely use
 * world space running to tens of thousands of units, so this only catches
 * true garbage (misread floats cluster near FLT_MAX ≈ 3.4e38).
 */
export const MAX_COORD = 1e9;

/** Check a polygon-json object set without modifying it. */
export function validatePolygonObjects(objects: PolygonObject[]): PolygonModelIssues {
  const issues: PolygonModelIssues = {
    nonFiniteVerts: 0,
    outOfRangeIndices: 0,
    implausibleExtents: 0,
  };

  for (const o of objects) {
    let extreme = false;
    for (const v of o.verts) {
      for (let i = 0; i < 3; i++) {
        const c = v[i];
        if (typeof c !== 'number' || !Number.isFinite(c)) {
          issues.nonFiniteVerts++;
        } else if (Math.abs(c) > MAX_COORD) {
          extreme = true;
        }
      }
    }
    if (extreme) issues.implausibleExtents++;

    const n = o.verts.length;
    for (const f of o.faces) {
      for (const idx of f.verts) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= n) issues.outOfRangeIndices++;
      }
    }
  }

  return issues;
}

export function hasIssues(issues: PolygonModelIssues): boolean {
  return issues.nonFiniteVerts > 0 || issues.outOfRangeIndices > 0 || issues.implausibleExtents > 0;
}

/** Render a `PolygonModelIssues` as a one-line human-readable summary. */
export function describeIssues(issues: PolygonModelIssues): string {
  const parts: string[] = [];
  if (issues.nonFiniteVerts > 0) parts.push(`${issues.nonFiniteVerts} non-finite coords`);
  if (issues.outOfRangeIndices > 0) {
    parts.push(`${issues.outOfRangeIndices} out-of-range face indices`);
  }
  if (issues.implausibleExtents > 0) {
    parts.push(`${issues.implausibleExtents} objects beyond ±${MAX_COORD.toExponential(0)}`);
  }
  return parts.join(', ');
}

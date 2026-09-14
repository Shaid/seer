import { describe, expect, it } from 'vitest';
import { validatePolygonObjects, hasIssues, describeIssues, type PolygonObject } from '../polygon-validate.js';

function obj(verts: number[][], faces: number[][]): PolygonObject {
  return {
    id: 0,
    name: 'mesh0',
    verts,
    faces: faces.map((v) => ({ verts: v, fill: 0 })),
    stats: { vertices: verts.length, triangles: faces.length },
  };
}

describe('polygon model validation', () => {
  it('accepts a well-formed mesh', () => {
    const issues = validatePolygonObjects([
      obj(
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        [[0, 1, 2]],
      ),
    ]);
    expect(hasIssues(issues)).toBe(false);
  });

  it('flags non-finite coordinates', () => {
    // This is the CGFX failure mode: NaN/Infinity survives JSON.stringify as
    // `null`, so nothing downstream notices until the viewer renders nothing.
    const issues = validatePolygonObjects([
      obj(
        [
          [0, 0, 0],
          [NaN, 0, 0],
          [0, Infinity, 0],
        ],
        [[0, 1, 2]],
      ),
    ]);
    expect(issues.nonFiniteVerts).toBe(2);
    expect(hasIssues(issues)).toBe(true);
  });

  it('flags face indices outside the vertex array', () => {
    // This is the MT Framework MOD failure mode: absolute indices into a
    // shared vertex buffer, never rebased to the mesh's own slice.
    const issues = validatePolygonObjects([
      obj(
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        [[2058, 2059, 2060]],
      ),
    ]);
    expect(issues.outOfRangeIndices).toBe(3);
    expect(hasIssues(issues)).toBe(true);
  });

  it('flags coordinates near the float32 ceiling as garbage', () => {
    const issues = validatePolygonObjects([
      obj(
        [
          [0, 0, 0],
          [3.4e38, 0, 0],
        ],
        [],
      ),
    ]);
    expect(issues.implausibleExtents).toBe(1);
  });

  it('accepts Warriors-scale world coordinates', () => {
    // Warriors genuinely uses tens of thousands of units — the extent check
    // must not fire on legitimately large models.
    const issues = validatePolygonObjects([
      obj(
        [
          [0, 0, 0],
          [41562, -12000, 8000],
        ],
        [],
      ),
    ]);
    expect(hasIssues(issues)).toBe(false);
  });
});

describe('describeIssues', () => {
  it('joins each non-zero category into a comma-separated summary', () => {
    expect(describeIssues({ nonFiniteVerts: 2, outOfRangeIndices: 3, implausibleExtents: 0 })).toBe(
      '2 non-finite coords, 3 out-of-range face indices',
    );
  });

  it('is empty when there are no issues', () => {
    expect(describeIssues({ nonFiniteVerts: 0, outOfRangeIndices: 0, implausibleExtents: 0 })).toBe('');
  });
});

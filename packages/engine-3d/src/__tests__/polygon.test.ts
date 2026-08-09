import { describe, expect, it } from 'vitest';
import {
  buildPolygonModel,
  computeModelEdges,
  normalizePolygonModel,
  normalizePolygonSet,
  triangulateFan,
} from '../polygon.js';
import type { PolygonModel } from '../types.js';

describe('triangulateFan', () => {
  it('triangulates a 3-vertex face into exactly one triangle', () => {
    expect(triangulateFan(3)).toEqual([0, 1, 2]);
  });

  it('fan-triangulates a 4-vertex face into two triangles sharing vertex 0', () => {
    expect(triangulateFan(4)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('fan-triangulates a 6-vertex face into four triangles sharing vertex 0', () => {
    expect(triangulateFan(6)).toEqual([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]);
  });

  it('returns no triangles for a degenerate face (< 3 vertices)', () => {
    expect(triangulateFan(0)).toEqual([]);
    expect(triangulateFan(1)).toEqual([]);
    expect(triangulateFan(2)).toEqual([]);
  });
});

describe('computeModelEdges', () => {
  it('prefers declared edges[] over deriving from faces when both are present', () => {
    const model: Pick<PolygonModel, 'edges' | 'faces' | 'verts'> = {
      verts: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      edges: [[0, 1]], // deliberately NOT the full face ring
      faces: [{ verts: [0, 1, 2], fill: 0 }],
    };
    expect(computeModelEdges(model)).toEqual([[0, 1]]);
  });

  it("derives edges from each face's vertex ring (consecutive pairs, wrapping) when no edges[] is declared", () => {
    const model: Pick<PolygonModel, 'edges' | 'faces' | 'verts'> = {
      verts: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      edges: [],
      faces: [{ verts: [0, 1, 2, 3], fill: 0 }],
    };
    // Ring 0-1-2-3-0: edges (0,1) (1,2) (2,3) (3,0)->(0,3)
    expect(computeModelEdges(model)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [0, 3],
    ]);
  });

  it('dedupes (a,b) against (b,a) regardless of declaration order', () => {
    const model: Pick<PolygonModel, 'edges' | 'faces' | 'verts'> = {
      verts: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      edges: [
        [0, 1],
        [1, 0],
        [0, 1],
      ],
      faces: [],
    };
    expect(computeModelEdges(model)).toEqual([[0, 1]]);
  });

  it('dedupes edges derived from two faces sharing an edge', () => {
    const model: Pick<PolygonModel, 'edges' | 'faces' | 'verts'> = {
      verts: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      edges: [],
      faces: [
        { verts: [0, 1, 2], fill: 0 },
        { verts: [2, 1, 0], fill: 0 }, // shares edge (0,1)/(1,0) and (0,2)/(2,0) with the first face, reversed
      ],
    };
    const edges = computeModelEdges(model);
    const keys = edges.map(([a, b]) => `${a},${b}`);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate keys
    expect(keys).toContain('0,1');
    expect(keys).toContain('0,2');
    expect(keys).toContain('1,2');
  });

  it('drops out-of-range edge indices rather than throwing', () => {
    const model: Pick<PolygonModel, 'edges' | 'faces' | 'verts'> = {
      verts: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      edges: [
        [0, 1],
        [0, 5],
      ],
      faces: [],
    };
    expect(computeModelEdges(model)).toEqual([[0, 1]]);
  });
});

describe('normalizePolygonModel / normalizePolygonSet — regression: Carrier Command + hunter fixtures', () => {
  // Carrier Command's CURRENT broken `models.json` shape (see plan §7):
  // `vertices` (not `verts`), and bare `[v0,v1,v2]` face arrays — the fill/
  // attribute byte was dropped when the extractor wrote this file.
  const carrierCommandFixture = {
    id: 1,
    name: 'ship-hit-01',
    vertices: [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
      [10, 10, 0],
    ],
    faces: [
      [0, 1, 2],
      [1, 3, 2],
    ],
    type_hi: 4,
  };

  // hunter's `objects-geometry.json` shape: `verts` (already-correct field
  // name) and `{fill, verts}` face objects.
  const hunterFixture = {
    id: 42,
    name: 'crate',
    verts: [
      [0, 0, 0],
      [5, 0, 0],
      [0, 5, 0],
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 0],
    ],
    faces: [{ fill: 0x0203, verts: [0, 1, 2] }],
    effectId: 7,
    stats: { source: 'hunter' },
  };

  it("normalizes Carrier Command's bare-array faces without throwing, defaulting fill to 0", () => {
    const model = normalizePolygonModel(carrierCommandFixture, 0);
    expect(model.verts).toEqual(carrierCommandFixture.vertices);
    expect(model.faces).toEqual([
      { verts: [0, 1, 2], fill: 0 },
      { verts: [1, 3, 2], fill: 0 },
    ]);
    expect(model.typeTag).toBe(4);
    expect(model.edges).toEqual([]);
  });

  it("normalizes hunter's {fill,verts} face objects", () => {
    const model = normalizePolygonModel(hunterFixture, 0);
    expect(model.faces).toEqual([{ verts: [0, 1, 2], fill: 0x0203 }]);
    expect(model.typeTag).toBe(7);
    expect(model.edges).toEqual([
      [0, 1],
      [1, 2],
      [2, 0],
    ]);
    expect(model.stats).toEqual({ source: 'hunter' });
  });

  it('both fixtures normalize to the same PolygonModel shape (same keys, same types)', () => {
    const cc = normalizePolygonModel(carrierCommandFixture, 0);
    const hunter = normalizePolygonModel(hunterFixture, 1);
    expect(Object.keys(cc).sort()).toEqual(Object.keys(hunter).sort());
    for (const model of [cc, hunter]) {
      expect(Array.isArray(model.verts)).toBe(true);
      expect(Array.isArray(model.edges)).toBe(true);
      expect(Array.isArray(model.faces)).toBe(true);
      for (const face of model.faces) {
        expect(Array.isArray(face.verts)).toBe(true);
        expect(typeof face.fill).toBe('number');
      }
      expect(typeof model.typeTag).toBe('number');
      expect(typeof model.id).toBe('number');
    }
  });

  it("normalizePolygonSet handles a bare array (both fixtures' documents are arrays)", () => {
    const models = normalizePolygonSet([carrierCommandFixture, hunterFixture]);
    expect(models).toHaveLength(2);
    expect(models[0]!.id).toBe(1);
    expect(models[1]!.id).toBe(42);
  });

  it('normalizePolygonSet handles a {objects:[...]} wrapper', () => {
    const models = normalizePolygonSet({ objects: [hunterFixture] });
    expect(models).toHaveLength(1);
    expect(models[0]!.name).toBe('crate');
  });

  it('normalizePolygonSet returns [] for garbage input rather than throwing', () => {
    expect(normalizePolygonSet(null)).toEqual([]);
    expect(normalizePolygonSet(undefined)).toEqual([]);
    expect(normalizePolygonSet('not an array')).toEqual([]);
    expect(normalizePolygonSet({})).toEqual([]);
  });

  it('buildPolygonModel accepts both normalized fixtures without throwing and produces a merged faces mesh', () => {
    const cc = normalizePolygonModel(carrierCommandFixture, 0);
    const hunter = normalizePolygonModel(hunterFixture, 1);
    for (const model of [cc, hunter]) {
      const built = buildPolygonModel(model);
      expect(built.source).toBe('polygon');
      expect(built.repr.faces).not.toBeNull();
      // 2 triangles * 3 verts = 6 for CC; 1 triangle * 3 verts = 3 for hunter.
      const expectedVertexCount = model === cc ? 6 : 3;
      expect(built.repr.faces!.geometry.getAttribute('position').count).toBe(expectedVertexCount);
    }
  });
});

describe('normalizePolygonModel — field aliasing', () => {
  it('falls back id to the provided index when raw has no id', () => {
    const model = normalizePolygonModel({}, 7);
    expect(model.id).toBe(7);
  });

  it('aliases effectId > type_hi > flags for typeTag, in that priority order', () => {
    expect(normalizePolygonModel({ effectId: 1, type_hi: 2, flags: 3 }, 0).typeTag).toBe(1);
    expect(normalizePolygonModel({ type_hi: 2, flags: 3 }, 0).typeTag).toBe(2);
    expect(normalizePolygonModel({ flags: 3 }, 0).typeTag).toBe(3);
    expect(normalizePolygonModel({}, 0).typeTag).toBe(0);
  });

  it('aliases vertices > verts for the vertex array, in that priority order', () => {
    expect(normalizePolygonModel({ vertices: [[1, 1, 1]], verts: [[2, 2, 2]] }, 0).verts).toEqual([
      [1, 1, 1],
    ]);
    expect(normalizePolygonModel({ verts: [[2, 2, 2]] }, 0).verts).toEqual([[2, 2, 2]]);
  });
});

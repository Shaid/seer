import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyRenderMode,
  defaultRenderMode,
  supportedRenderModes,
  type RenderMode,
} from '../render-modes.js';
import type { Model3D, ModelRepresentations } from '../types.js';

function makePolygonModel(opts: { faces?: boolean; lines?: boolean; points?: boolean }): Model3D {
  const object = new THREE.Group();
  const repr: ModelRepresentations = {
    faces: null,
    lines: null,
    points: null,
    originalMaterials: new Map(),
  };

  if (opts.faces) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geom.setIndex([0, 1, 2]);
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
    repr.faces = mesh;
    object.add(mesh);
  }
  if (opts.lines) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
    const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial());
    repr.lines = lines;
    object.add(lines);
  }
  if (opts.points) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const pts = new THREE.Points(geom, new THREE.PointsMaterial());
    repr.points = pts;
    object.add(pts);
  }

  return { object, source: 'polygon', animations: [], hasTextures: false, repr };
}

function makeGltfModel(): {
  model: Model3D;
  mesh: THREE.Mesh;
  originalMaterial: THREE.MeshStandardMaterial;
} {
  const object = new THREE.Group();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const originalMaterial = new THREE.MeshStandardMaterial({ color: 0xff8800 });
  const mesh = new THREE.Mesh(geom, originalMaterial);
  object.add(mesh);

  const originalMaterials: ModelRepresentations['originalMaterials'] = new Map();
  originalMaterials.set(mesh, originalMaterial);
  const repr: ModelRepresentations = { faces: null, lines: null, points: null, originalMaterials };

  return {
    model: { object, source: 'gltf', animations: [], hasTextures: true, repr },
    mesh,
    originalMaterial,
  };
}

describe('supportedRenderModes / defaultRenderMode — applicability matrix', () => {
  const cases: Array<{
    name: string;
    model: () => Model3D;
    supported: RenderMode[];
    def: RenderMode;
  }> = [
    {
      name: 'polygon with faces+wireframe+points all built',
      model: () => makePolygonModel({ faces: true, lines: true, points: true }),
      supported: ['faces', 'wireframe', 'points'],
      def: 'faces',
    },
    {
      name: 'polygon with no faces[] (wireframe+points only)',
      model: () => makePolygonModel({ lines: true, points: true }),
      supported: ['wireframe', 'points'],
      def: 'wireframe',
    },
    {
      name: 'polygon with points only (no faces, no derivable edges)',
      model: () => makePolygonModel({ points: true }),
      supported: ['points'],
      def: 'points',
    },
    {
      name: 'polygon with nothing built (empty model)',
      model: () => makePolygonModel({}),
      supported: [],
      def: 'points',
    },
    {
      name: 'gltf always supports all four regardless of repr contents',
      model: () => makeGltfModel().model,
      supported: ['textured', 'faces', 'wireframe', 'points'],
      def: 'textured',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const model = c.model();
      expect(supportedRenderModes(model)).toEqual(c.supported);
      expect(defaultRenderMode(model)).toBe(c.def);
    });
  }

  it('polygon never supports "textured" — no texture data at all', () => {
    const model = makePolygonModel({ faces: true, lines: true, points: true });
    expect(supportedRenderModes(model)).not.toContain('textured');
  });
});

describe('applyRenderMode — polygon', () => {
  it('toggles .visible on exactly the representation matching the requested mode', () => {
    const model = makePolygonModel({ faces: true, lines: true, points: true });
    applyRenderMode(model, 'wireframe');
    expect(model.repr.faces!.visible).toBe(false);
    expect(model.repr.lines!.visible).toBe(true);
    expect(model.repr.points!.visible).toBe(false);

    applyRenderMode(model, 'points');
    expect(model.repr.faces!.visible).toBe(false);
    expect(model.repr.lines!.visible).toBe(false);
    expect(model.repr.points!.visible).toBe(true);
  });

  it('falls back to defaultRenderMode() for an unsupported mode instead of rendering nothing', () => {
    const model = makePolygonModel({ lines: true, points: true }); // no faces
    applyRenderMode(model, 'faces'); // unsupported — should fall back to 'wireframe'
    expect(model.repr.lines!.visible).toBe(true);
    expect(model.repr.points!.visible).toBe(false);
  });
});

describe('applyRenderMode — gltf', () => {
  it('"textured" restores the mesh\'s original material', () => {
    const { model, mesh, originalMaterial } = makeGltfModel();
    applyRenderMode(model, 'faces');
    expect(mesh.material).not.toBe(originalMaterial);
    applyRenderMode(model, 'textured');
    expect(mesh.material).toBe(originalMaterial);
    expect(mesh.visible).toBe(true);
  });

  it('"faces" swaps in a flat MeshLambertMaterial tinted from the original material\'s color', () => {
    const { model, mesh, originalMaterial } = makeGltfModel();
    applyRenderMode(model, 'faces');
    expect(mesh.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect((mesh.material as THREE.MeshLambertMaterial).color.getHex()).toBe(
      originalMaterial.color.getHex(),
    );
    expect(mesh.visible).toBe(true);
  });

  it('"wireframe" swaps in a wireframe MeshBasicMaterial', () => {
    const { model, mesh } = makeGltfModel();
    applyRenderMode(model, 'wireframe');
    expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((mesh.material as THREE.MeshBasicMaterial).wireframe).toBe(true);
  });

  it('"points" hides the mesh and lazily builds+caches a merged Points sibling', () => {
    const { model, mesh } = makeGltfModel();
    expect(model.repr.points).toBeNull();

    applyRenderMode(model, 'points');
    expect(mesh.visible).toBe(false);
    expect(model.repr.points).not.toBeNull();
    expect(model.repr.points!.visible).toBe(true);

    const builtPoints = model.repr.points;
    applyRenderMode(model, 'faces');
    expect(builtPoints!.visible).toBe(false);
    applyRenderMode(model, 'points');
    // Cached, not rebuilt.
    expect(model.repr.points).toBe(builtPoints);
  });

  it('caches the generated faces/wireframe materials across repeated mode switches', () => {
    const { model, mesh } = makeGltfModel();
    applyRenderMode(model, 'faces');
    const firstFacesMaterial = mesh.material;
    applyRenderMode(model, 'wireframe');
    applyRenderMode(model, 'faces');
    expect(mesh.material).toBe(firstFacesMaterial);
  });
});

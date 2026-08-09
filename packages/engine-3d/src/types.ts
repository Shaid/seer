import * as THREE from 'three';

/**
 * One face of a polygon model: a vertex-index ring plus a raw "fill" value
 * whose meaning is entirely game-specific (an Amiga palette+VPF word for
 * Hunter/Carrier Command, an attribute byte for Carrier Command's ship hit
 * boxes, ...). `color-modes.ts` is the only place that ever interprets it,
 * and only via a caller-supplied `ColorResolver` — this package never
 * hardcodes a palette.
 */
export interface PolygonFace {
  verts: number[];
  fill: number;
}

/**
 * The `{verts,edges,faces}` shape hunter/Carrier Command's own extractors
 * produce, normalized to one canonical field naming (see `polygon.ts`'s
 * `normalizePolygonModel`, which is what actually accepts the several raw
 * on-disk variants and produces this).
 */
export interface PolygonModel {
  id: number;
  name?: string;
  verts: number[][];
  edges: number[][];
  faces: PolygonFace[];
  /**
   * Generic rename of whatever per-model type/behaviour tag the source game
   * uses (hunter's `effectId`, Carrier Command's `type_hi`/`flags`) — the
   * package itself never branches on it, it's carried through for a host's
   * own display purposes only.
   */
  typeTag: number;
  stats: Record<string, unknown>;
}

export type ModelSource = 'gltf' | 'polygon';

/**
 * The prebuilt faces/lines/points representations a `Model3D` carries
 * internally so `render-modes.ts` can toggle `.visible` on each without
 * rebuilding geometry or losing the camera framing on every mode switch.
 * Not part of the public per-module API surface (no module exports a way to
 * construct one directly) but it's a real field on `Model3D`, so hosts that
 * inspect `model.repr` (e.g. for stats) need the shape.
 */
export interface ModelRepresentations {
  /** One merged mesh covering every face, or `null` for a model with no faces (an edges/points-only object). */
  faces: (THREE.Mesh | THREE.SkinnedMesh) | null;
  /** One merged `LineSegments` covering every edge, or `null` if there are none. */
  lines: THREE.LineSegments | null;
  /** One merged `Points` covering every vertex. Built eagerly for a polygon model (cheap); for glTF, `render-modes.ts` builds this lazily on first use and caches it here. */
  points: THREE.Points | null;
  /**
   * The materials each mesh under `object` was constructed/loaded with,
   * keyed by the mesh itself — `render-modes.ts`'s `'textured'` mode restores
   * these after a `'faces'`/`'wireframe'` mode swapped in a flat material.
   * Only meaningful for `source: 'gltf'`; empty for a polygon model (which
   * has no "original" textured material to restore).
   */
  originalMaterials: Map<THREE.Mesh | THREE.SkinnedMesh, THREE.Material | THREE.Material[]>;
}

/**
 * The one shape every host adds to its viewport: a glTF's native scene graph
 * and a `{verts,edges,faces}` polygon's built `Object3D` converge here, so
 * `viewport.ts`/`placed-scene.ts`/`animation.ts` etc. never need to know
 * which path a given model came from.
 */
export interface Model3D {
  /** The one thing every host adds to `viewport.root`. */
  object: THREE.Object3D;
  source: ModelSource;
  animations: THREE.AnimationClip[];
  hasTextures: boolean;
  /** The normalized source polygon data, present only when `source === 'polygon'`. */
  polygon?: PolygonModel;
  /** Internal: prebuilt faces/lines/points + cached original materials. See `ModelRepresentations`. */
  readonly repr: ModelRepresentations;
}

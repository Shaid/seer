import * as THREE from 'three';
import type { Model3D, ModelRepresentations, PolygonFace, PolygonModel } from './types.js';
import {
  resolveColor,
  type ColorMode,
  type ColorResolver,
  type HeightRange,
} from './color-modes.js';

// ── normalization ────────────────────────────────────────────────────────

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asNumberTuple(v: unknown): number[] {
  return Array.isArray(v) ? v.map((n) => asFiniteNumber(n) ?? 0) : [];
}

function asVertexArray(v: unknown): number[][] | undefined {
  return Array.isArray(v) ? v.map((p) => asNumberTuple(p)) : undefined;
}

function asEdgeArray(v: unknown): number[][] {
  return Array.isArray(v) ? v.map((e) => asNumberTuple(e)) : [];
}

/** Accepts a face as `{verts, fill}` (hunter's `objects-geometry.json` shape) OR a bare `number[]` (Carrier Command's current, lossy `models.json` shape, where the fill/attribute byte was dropped on write — see the plan's §7). A bare array normalizes to `fill: 0`, i.e. "no known color". */
function asFace(raw: unknown): PolygonFace {
  if (Array.isArray(raw)) return { verts: asNumberTuple(raw), fill: 0 };
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { verts: asNumberTuple(o.verts), fill: asFiniteNumber(o.fill) ?? 0 };
}

function asFaceArray(v: unknown): PolygonFace[] {
  return Array.isArray(v) ? v.map(asFace) : [];
}

/**
 * Normalizes one raw JSON object into the package's canonical `PolygonModel`
 * shape: aliases `vertices`/`verts` for the vertex array and
 * `effectId`/`type_hi`/`flags` for the generic `typeTag`, and accepts faces
 * as either `{verts,fill}` objects or bare `number[]` vertex-index arrays.
 * Defensive against a completely malformed/non-object `raw` (falls back to
 * an empty model at `index`) rather than throwing, since one bad entry in a
 * multi-hundred-object manifest shouldn't take the whole list down.
 */
export function normalizePolygonModel(raw: unknown, index: number): PolygonModel {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const verts = asVertexArray(o.vertices) ?? asVertexArray(o.verts) ?? [];
  const edges = asEdgeArray(o.edges);
  const faces = asFaceArray(o.faces);
  const typeTag =
    asFiniteNumber(o.effectId) ?? asFiniteNumber(o.type_hi) ?? asFiniteNumber(o.flags) ?? 0;
  const stats = o.stats && typeof o.stats === 'object' ? (o.stats as Record<string, unknown>) : {};
  const id = asFiniteNumber(o.id) ?? index;
  const name = typeof o.name === 'string' ? o.name : undefined;

  return { id, name, verts, edges, faces, typeTag, stats };
}

/**
 * Normalizes a raw polygon-set JSON document into `PolygonModel[]`. Accepts
 * a bare array (hunter's `objects-geometry.json`, Carrier Command's
 * `models.json`) or a `{objects: [...]}` wrapper, mirroring hunter's
 * existing `Array.isArray(data) ? data : data?.objects ?? []` fallback
 * (`viewer.ts:546`).
 */
export function normalizePolygonSet(raw: unknown): PolygonModel[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : ((raw && typeof raw === 'object' ? (raw as { objects?: unknown[] }).objects : undefined) ??
      []);
  return list.map((item, i) => normalizePolygonModel(item, i));
}

// ── triangulation / edge derivation (pure, unit-tested directly) ──────────

/**
 * Fan-triangulates an `n`-vertex face into `n-2` triangles, all sharing
 * local vertex `0`: `[0,1,2, 0,2,3, ..., 0,n-2,n-1]`. Matches hunter's
 * `buildMesh` triangulation (`viewer.ts:346-347`). Indices are relative to
 * the face's own vertex list (0-based) — callers building a merged
 * multi-face buffer add their running vertex-count `base` to each entry.
 * Returns `[]` for `n < 3` (degenerate face, nothing to triangulate).
 */
export function triangulateFan(vertexCount: number): number[] {
  if (vertexCount < 3) return [];
  const indices: number[] = [];
  for (let i = 1; i < vertexCount - 1; i++) indices.push(0, i, i + 1);
  return indices;
}

/**
 * Derives the undirected edge set for a polygon model: prefers the model's
 * own declared `edges[]` when present, otherwise derives edges from each
 * face's vertex ring (consecutive pairs, wrapping around), and either way
 * dedupes `(a,b)` against `(b,a)` — matching hunter's `buildMesh` wireframe
 * logic (`viewer.ts:356-392`). Out-of-range indices (≥ `vertexCount`) are
 * dropped rather than clamped, so a malformed edge/face doesn't silently
 * connect the wrong vertices.
 */
export function computeModelEdges(
  model: Pick<PolygonModel, 'edges' | 'faces' | 'verts'>,
): Array<[number, number]> {
  const vertexCount = model.verts.length;
  const seen = new Set<string>();
  const result: Array<[number, number]> = [];

  const add = (a: number, b: number) => {
    if (a >= vertexCount || b >= vertexCount || a < 0 || b < 0 || a === b) return;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(a < b ? [a, b] : [b, a]);
  };

  if (model.edges.length > 0) {
    for (const e of model.edges) {
      if (e.length >= 2) add(e[0]!, e[1]!);
    }
    return result;
  }

  for (const face of model.faces) {
    const idx = face.verts;
    for (let i = 0; i < idx.length; i++) {
      add(idx[i]!, idx[(i + 1) % idx.length]!);
    }
  }
  return result;
}

// ── build ───────────────────────────────────────────────────────────────

export interface PolygonBuildOptions {
  /** Initial color mode used to shade the merged faces representation. Default `'object'` — meaningful for any model with no injected palette, unlike `'palette'` which renders flat grey without a `colorResolver`. */
  colorMode?: ColorMode;
  /** Resolver for `'palette'` mode — see `createPaletteResolver`. */
  colorResolver?: ColorResolver;
  /**
   * Re-centers the built object around its own vertex centroid, matching
   * hunter's `buildMesh` (`viewer.ts:318-321`), so the object sits near the
   * scene origin regardless of the source data's own coordinate offsets.
   * Default `true`.
   */
  center?: boolean;
  /** Flat line color for the wireframe representation. Default `0x88ccff` (hunter's original). */
  lineColor?: number;
  /** Flat point color for the points representation (ignored for models with no faces, where hunter's original defaulted points to a height-tinted color — reproduced when `colorMode === 'height'` and no explicit `pointColor` is given). Default `0x88ccff`. */
  pointColor?: number;
  /** Point sprite size, in scene units. Default `30` (hunter's original `PointsMaterial` size). */
  pointSize?: number;
}

function vertexAt(points: THREE.Vector3[], index: number): THREE.Vector3 {
  const clamped = Math.min(Math.max(index, 0), points.length - 1);
  return points[clamped] ?? new THREE.Vector3();
}

function computeCentroid(verts: number[][]): [number, number, number] {
  if (verts.length === 0) return [0, 0, 0];
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const v of verts) {
    cx += v[0] ?? 0;
    cy += v[1] ?? 0;
    cz += v[2] ?? 0;
  }
  return [cx / verts.length, cy / verts.length, cz / verts.length];
}

function heightRangeOf(points: THREE.Vector3[]): HeightRange | undefined {
  if (points.length === 0) return undefined;
  let min = Infinity,
    max = -Infinity;
  for (const p of points) {
    if (p.y < min) min = p.y;
    if (p.y > max) max = p.y;
  }
  return min <= max ? { min, max } : undefined;
}

function buildFacesRepr(
  model: PolygonModel,
  points: THREE.Vector3[],
  colorMode: ColorMode,
  colorResolver: ColorResolver | undefined,
  heightRange: HeightRange | undefined,
): THREE.Mesh | null {
  if (model.faces.length === 0) return null;

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let base = 0;

  for (let fi = 0; fi < model.faces.length; fi++) {
    const face = model.faces[fi]!;
    if (face.verts.length < 3) continue;

    const y0 = vertexAt(points, face.verts[0]!).y;
    const color = resolveColor(
      colorMode,
      { objectId: model.id, faceIndex: fi, fill: face.fill, y: y0, heightRange },
      colorResolver,
    );

    for (const vi of face.verts) {
      const p = vertexAt(points, vi);
      positions.push(p.x, p.y, p.z);
      colors.push(color.r, color.g, color.b);
    }
    for (const rel of triangulateFan(face.verts.length)) indices.push(base + rel);
    base += face.verts.length;
  }

  if (positions.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  return new THREE.Mesh(geom, material);
}

function buildLinesRepr(
  model: PolygonModel,
  points: THREE.Vector3[],
  lineColor: number,
): THREE.LineSegments | null {
  const edges = computeModelEdges(model);
  if (edges.length === 0) return null;

  const positions: number[] = [];
  for (const [a, b] of edges) {
    const pa = vertexAt(points, a);
    const pb = vertexAt(points, b);
    positions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: lineColor,
    transparent: true,
    opacity: 0.5,
  });
  return new THREE.LineSegments(geom, material);
}

function buildPointsRepr(
  points: THREE.Vector3[],
  pointColor: number,
  pointSize: number,
): THREE.Points | null {
  if (points.length === 0) return null;
  const positions: number[] = [];
  for (const p of points) positions.push(p.x, p.y, p.z);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: pointColor,
    size: pointSize,
    sizeAttenuation: true,
  });
  return new THREE.Points(geom, material);
}

/**
 * Builds a `Model3D` from a normalized `PolygonModel` — the core of the
 * verts/faces → `Object3D` adapter. Three real upgrades over hunter's
 * current `buildMesh` (`viewer.ts:313-405`):
 *
 * 1. One merged `BufferGeometry` for all faces (and one each for lines/
 *    points), instead of one geometry+mesh+material *per face*.
 * 2. All three representations are built once, added as siblings under one
 *    `THREE.Group`, and toggled by `.visible` (see `render-modes.ts`) — no
 *    rebuild and no camera-refit on a render-mode change.
 * 3. `recolorPolygonModel` rewrites the faces geometry's `color` attribute
 *    in place instead of rebuilding it.
 */
export function buildPolygonModel(model: PolygonModel, opts: PolygonBuildOptions = {}): Model3D {
  const center = opts.center ?? true;
  const colorMode = opts.colorMode ?? 'object';
  const lineColor = opts.lineColor ?? 0x88ccff;
  const pointColor = opts.pointColor ?? 0x88ccff;
  const pointSize = opts.pointSize ?? 30;

  const [cx, cy, cz] = center ? computeCentroid(model.verts) : [0, 0, 0];
  const points = model.verts.map(
    (v) => new THREE.Vector3((v[0] ?? 0) - cx, (v[1] ?? 0) - cy, (v[2] ?? 0) - cz),
  );
  const heightRange = heightRangeOf(points);

  const faces = buildFacesRepr(model, points, colorMode, opts.colorResolver, heightRange);
  const lines = buildLinesRepr(model, points, lineColor);
  const pts = buildPointsRepr(points, pointColor, pointSize);

  const object = new THREE.Group();
  // A sane standalone default: show faces if there are any, else lines, else
  // points — a host that cares about a specific initial mode should call
  // `applyRenderMode(model, defaultRenderMode(model))` right after this
  // (which `session.ts.setModel` does), overriding this default anyway.
  if (faces) {
    faces.visible = true;
    object.add(faces);
  }
  if (lines) {
    lines.visible = !faces;
    object.add(lines);
  }
  if (pts) {
    pts.visible = !faces && !lines;
    object.add(pts);
  }

  const repr: ModelRepresentations = {
    faces,
    lines,
    points: pts,
    originalMaterials: new Map(),
  };

  return {
    object,
    source: 'polygon',
    animations: [],
    hasTextures: false,
    polygon: model,
    repr,
  };
}

/**
 * Rewrites `model`'s merged faces geometry `color` attribute in place for a
 * new color mode/resolver — no geometry rebuild, matching upgrade (3) on
 * `buildPolygonModel`'s doc comment. Only meaningful for a polygon-sourced
 * model (`model.polygon` set, `model.repr.faces` a per-vertex-colored merged
 * mesh) — a no-op for a glTF-sourced model, whose materials already carry
 * real color/texture information that a `ColorMode` has no data to usefully
 * override (see `color-modes.ts`'s doc comment on `ColorMode`).
 */
export function recolorPolygonModel(
  model: Model3D,
  mode: ColorMode,
  resolver?: ColorResolver,
): void {
  const polygon = model.polygon;
  const facesMesh = model.repr.faces;
  if (!polygon || !facesMesh) return;

  const colorAttr = facesMesh.geometry.getAttribute('color');
  if (!colorAttr) return;

  const positionAttr = facesMesh.geometry.getAttribute('position');
  const heightRange = positionAttr ? heightRangeFromAttribute(positionAttr) : undefined;

  let vertexCursor = 0;
  for (let fi = 0; fi < polygon.faces.length; fi++) {
    const face = polygon.faces[fi]!;
    if (face.verts.length < 3) continue;
    const y0 = positionAttr ? positionAttr.getY(vertexCursor) : 0;
    const color = resolveColor(
      mode,
      { objectId: polygon.id, faceIndex: fi, fill: face.fill, y: y0, heightRange },
      resolver,
    );
    for (let i = 0; i < face.verts.length; i++) {
      colorAttr.setXYZ(vertexCursor, color.r, color.g, color.b);
      vertexCursor++;
    }
  }
  colorAttr.needsUpdate = true;
}

function heightRangeFromAttribute(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): HeightRange | undefined {
  if (attr.count === 0) return undefined;
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < attr.count; i++) {
    const y = attr.getY(i);
    if (y < min) min = y;
    if (y > max) max = y;
  }
  return min <= max ? { min, max } : undefined;
}

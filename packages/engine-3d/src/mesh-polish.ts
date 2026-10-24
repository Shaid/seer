import * as THREE from 'three';
import type { Model3D } from './types.js';
import { isMesh } from './three-utils.js';

const POSITION_WELD_EPSILON = 1e-5;

/**
 * Whether `geometry` carries skinning data (`skinIndex`/`skinWeight`
 * attributes) that `subdivideGeometry`'s rebuild would silently drop —
 * `applyMeshPolish` uses this to leave a `SkinnedMesh`'s geometry untouched
 * rather than corrupting its deformation.
 */
function isSkinnedGeometry(geometry: THREE.BufferGeometry): boolean {
  return !!geometry.getAttribute('skinIndex') || !!geometry.getAttribute('skinWeight');
}

function positionKey(v: THREE.Vector3): string {
  return `${Math.round(v.x / POSITION_WELD_EPSILON)},${Math.round(v.y / POSITION_WELD_EPSILON)},${Math.round(v.z / POSITION_WELD_EPSILON)}`;
}

/** Smooth normals across coincident positions while retaining texture-UV seams. */
export function applySmoothNormals(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return;
  const incident = new Map<string, THREE.Vector3[]>();
  const cornerNormal: THREE.Vector3[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    const faceNormal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
    if (faceNormal.lengthSq() === 0) continue;
    faceNormal.normalize();
    for (const [corner, point] of [a, b, c].entries()) {
      const key = positionKey(point);
      (incident.get(key) ?? incident.set(key, []).get(key)!).push(faceNormal);
      cornerNormal[i + corner] = faceNormal;
    }
  }
  const normal = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    a.fromBufferAttribute(pos, i);
    const own = cornerNormal[i] ?? new THREE.Vector3(0, 1, 0);
    const n = new THREE.Vector3();
    // Preserve hard edges: only average faces within a 60° crease angle.
    for (const candidate of incident.get(positionKey(a)) ?? []) if (candidate.dot(own) >= 0.5) n.add(candidate);
    if (n.lengthSq() === 0) n.copy(own); else n.normalize();
    normal.set([n.x, n.y, n.z], i * 3);
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
}

type MeshCorner = { position: THREE.Vector3; uv?: THREE.Vector2 };
type MeshTriangle = [MeshCorner, MeshCorner, MeshCorner];

/** Round interior vertices while leaving open boundaries in place. */
function relaxInteriorPositions(geometry: THREE.BufferGeometry, strength: number): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return;
  const vertices = new Map<string, { point: THREE.Vector3; neighbors: Set<string>; boundary: boolean }>();
  const edges = new Map<string, number>();
  const point = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    point.fromBufferAttribute(pos, i);
    const key = positionKey(point);
    if (!vertices.has(key)) vertices.set(key, { point: point.clone(), neighbors: new Set(), boundary: false });
  }
  const addEdge = (a: string, b: string) => {
    vertices.get(a)!.neighbors.add(b); vertices.get(b)!.neighbors.add(a);
    const edge = a < b ? `${a}/${b}` : `${b}/${a}`;
    edges.set(edge, (edges.get(edge) ?? 0) + 1);
  };
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const keys = [i, i + 1, i + 2].map((index) => positionKey(point.fromBufferAttribute(pos, index)));
    addEdge(keys[0]!, keys[1]!); addEdge(keys[1]!, keys[2]!); addEdge(keys[2]!, keys[0]!);
  }
  for (const [edge, count] of edges) if (count === 1) {
    const [a, b] = edge.split('/'); vertices.get(a!)!.boundary = true; vertices.get(b!)!.boundary = true;
  }
  const relaxed = new Map<string, THREE.Vector3>();
  for (const [key, vertex] of vertices) {
    if (vertex.boundary || vertex.neighbors.size < 3) { relaxed.set(key, vertex.point); continue; }
    const average = new THREE.Vector3();
    for (const neighbor of vertex.neighbors) average.add(vertices.get(neighbor)!.point);
    relaxed.set(key, vertex.point.clone().lerp(average.multiplyScalar(1 / vertex.neighbors.size), strength));
  }
  for (let i = 0; i < pos.count; i++) {
    point.fromBufferAttribute(pos, i); point.copy(relaxed.get(positionKey(point))!);
    pos.setXYZ(i, point.x, point.y, point.z);
  }
  pos.needsUpdate = true;
}

/**
 * Doubles triangles per pass, smoothly relaxing interior positions and
 * interpolating UVs. `multiplier` is an intensity scale, not a literal pass
 * count — kept logarithmic so an `8×` selection doesn't explode to `256×`
 * triangles. `multiplier <= 0` still normalizes `source` to non-indexed and
 * clones it, but does no subdivision work.
 */
export function subdivideGeometry(source: THREE.BufferGeometry, multiplier: number): THREE.BufferGeometry {
  const base = source.index ? source.toNonIndexed() : source.clone();
  const pos = base.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || multiplier <= 0) return base;
  const uv = base.getAttribute('uv') as THREE.BufferAttribute | undefined;
  let triangles: MeshTriangle[] = [];
  for (let i = 0; i + 2 < pos.count; i += 3) {
    triangles.push([0, 1, 2].map((offset) => ({
      position: new THREE.Vector3().fromBufferAttribute(pos, i + offset),
      uv: uv ? new THREE.Vector2().fromBufferAttribute(uv, i + offset) : undefined,
    })) as MeshTriangle);
  }
  const midpoint = (a: MeshCorner, b: MeshCorner): MeshCorner => ({
    position: a.position.clone().add(b.position).multiplyScalar(0.5),
    uv: a.uv && b.uv ? a.uv.clone().add(b.uv).multiplyScalar(0.5) : undefined,
  });
  const passes = Math.round(Math.log2(multiplier)) + 1;
  for (let pass = 0; pass < passes; pass++) {
    const next: MeshTriangle[] = [];
    for (const [a, b, c] of triangles) {
      const ab = a.position.distanceToSquared(b.position);
      const bc = b.position.distanceToSquared(c.position);
      const ca = c.position.distanceToSquared(a.position);
      if (ab >= bc && ab >= ca) { const m = midpoint(a, b); next.push([a, m, c], [m, b, c]); }
      else if (bc >= ca) { const m = midpoint(b, c); next.push([b, m, a], [m, c, a]); }
      else { const m = midpoint(c, a); next.push([c, m, b], [m, a, b]); }
    }
    triangles = next;
  }
  base.dispose();
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const triangle of triangles) for (const corner of triangle) {
    positions.push(corner.position.x, corner.position.y, corner.position.z);
    if (uv) uvs.push(corner.uv!.x, corner.uv!.y);
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (uv) result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  relaxInteriorPositions(result, 0.08 * passes);
  return result;
}

/** Per-mesh original (pre-subdivision) geometry, owned by the caller (`session.ts`) — captured once per model load via `captureOriginalGeometry` and disposed via `disposeOriginalGeometry` on model switch/session dispose. */
export type OriginalGeometryCache = Map<THREE.Mesh, THREE.BufferGeometry>;

/** Clones and remembers every mesh's current geometry in a glTF `Model3D`, the baseline `applyMeshPolish` rebuilds from on every subdivision/smoothing change. Returns an empty cache for a polygon model (no polish concept there). */
export function captureOriginalGeometry(model: Model3D): OriginalGeometryCache {
  const cache: OriginalGeometryCache = new Map();
  if (model.source !== 'gltf') return cache;
  model.object.traverse((object) => {
    if (isMesh(object)) cache.set(object, object.geometry.clone());
  });
  return cache;
}

/** Disposes every geometry `captureOriginalGeometry` cloned and empties `cache`. Safe to call on an empty cache. */
export function disposeOriginalGeometry(cache: OriginalGeometryCache): void {
  for (const geometry of cache.values()) geometry.dispose();
  cache.clear();
}

/**
 * Rebuilds each mesh's geometry from `originalGeometry` at `opts.subdivision`
 * intensity, smooth- or flat-normaled per `opts.smooth`. No-op for a polygon
 * model or a mesh missing from `originalGeometry` (never captured, or this
 * model wasn't loaded via glTF). Rebuilding must not disturb camera state —
 * callers typically follow this with a render-mode/shading refresh, never a
 * re-fit.
 *
 * Also a no-op — geometry left exactly as-is — for any mesh that is a
 * `SkinnedMesh` (carries `skinIndex`/`skinWeight` attributes) or whose
 * material is an array (per-`groups` multi-material). `subdivideGeometry`'s
 * rebuild only ever emits `position`/`uv`, so applying it to either would
 * silently break the mesh: an animated skinned character's deformation
 * (no `skinIndex`/`skinWeight` survives the rebuild) or a multi-material
 * mesh's rendering entirely (three.js draws nothing for a `groups`-less
 * geometry assigned a material array).
 */
export function applyMeshPolish(
  model: Model3D,
  originalGeometry: OriginalGeometryCache,
  opts: { subdivision: number; smooth: boolean },
): void {
  if (model.source !== 'gltf') return;
  model.object.traverse((object) => {
    if (!isMesh(object)) return;
    const mesh = object;
    const original = originalGeometry.get(mesh);
    if (!original) return;
    if (isSkinnedGeometry(original) || Array.isArray(mesh.material)) return;
    if (mesh.geometry !== original) mesh.geometry.dispose();
    mesh.geometry = subdivideGeometry(original, opts.subdivision);
    if (opts.smooth) applySmoothNormals(mesh.geometry);
    else mesh.geometry.computeVertexNormals();
  });
}

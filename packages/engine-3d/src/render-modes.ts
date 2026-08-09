import * as THREE from 'three';
import type { Model3D } from './types.ts';

/**
 * The four ways a `Model3D` can be drawn. This is where the glTF/polygon
 * structural gap is absorbed, and only here — everything else in the
 * package (`polygon.ts`, `gltf.ts`, `viewport.ts`, ...) is agnostic to
 * which source a given `Model3D` came from.
 *
 * | mode | polygon | glTF |
 * |---|---|---|
 * | `textured` | unsupported (no texture data) | restore cached original materials |
 * | `faces` | `repr.faces` (merged, per-vertex-colored) | flat `MeshLambertMaterial` per mesh, tinted from that mesh's own original `.color` |
 * | `wireframe` | `repr.lines` | flat `MeshBasicMaterial({wireframe:true})` per mesh, same tint |
 * | `points` | `repr.points` (built eagerly) | lazily built merged sibling `THREE.Points`, cached on `repr.points` |
 *
 * Hunter's current `'both'` mode is dropped (the 4-mode list this generalizes
 * from is `textured`/`faces`/`wireframe`/`points`); if a wireframe-over-faces
 * overlay is wanted later, that's a `wireframeOverlay?: boolean` build
 * option rather than a 5th mode.
 */
export type RenderMode = 'textured' | 'faces' | 'wireframe' | 'points';

const ALL_MODES: RenderMode[] = ['textured', 'faces', 'wireframe', 'points'];

/**
 * Which render modes `model` can actually display. A glTF model supports
 * all four unconditionally (every mesh can be flat-shaded or turned into
 * points on demand); a polygon model supports only whichever representations
 * `buildPolygonModel` actually built (a model with no `faces[]` has no
 * `'faces'` mode, one with no derivable edges has no `'wireframe'`), and
 * never supports `'textured'` — it has no texture data at all.
 */
export function supportedRenderModes(model: Model3D): RenderMode[] {
  if (model.source === 'gltf') return [...ALL_MODES];
  const modes: RenderMode[] = [];
  if (model.repr.faces) modes.push('faces');
  if (model.repr.lines) modes.push('wireframe');
  if (model.repr.points) modes.push('points');
  return modes;
}

/** The mode `applyRenderMode` falls back to when asked for an unsupported one. `'textured'` for glTF (its richest mode), otherwise the first supported mode in `faces` > `wireframe` > `points` priority, or `'points'` for a completely empty model (nothing else to fall back to). */
export function defaultRenderMode(model: Model3D): RenderMode {
  const supported = supportedRenderModes(model);
  if (model.source === 'gltf') return supported.includes('textured') ? 'textured' : (supported[0] ?? 'textured');
  return supported[0] ?? 'points';
}

// ── polygon application ────────────────────────────────────────────────

function applyPolygonRenderMode(model: Model3D, mode: RenderMode): void {
  const { faces, lines, points } = model.repr;
  if (faces) faces.visible = mode === 'faces';
  if (lines) lines.visible = mode === 'wireframe';
  if (points) points.visible = mode === 'points';
}

// ── glTF application ────────────────────────────────────────────────────

interface GeneratedMaterialCache {
  faces?: THREE.MeshLambertMaterial;
  wireframe?: THREE.MeshBasicMaterial;
}

/**
 * Per-mesh cache of the flat materials `'faces'`/`'wireframe'` mode build on
 * demand, keyed by the mesh itself so repeated mode switches don't rebuild
 * (and don't leak — a mesh going out of scope drops its cache entry too).
 * Deliberately not stored on `ModelRepresentations`: it's an implementation
 * detail of *this* module's glTF handling, not part of the shape polygon
 * models also populate.
 */
const generatedMaterialCache = new WeakMap<THREE.Object3D, GeneratedMaterialCache>();

function isMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as { isMesh?: boolean }).isMesh === true;
}

function originalColorOf(material: THREE.Material | THREE.Material[] | undefined): THREE.Color {
  const mat = Array.isArray(material) ? material[0] : material;
  const color = (mat as { color?: THREE.Color } | undefined)?.color;
  return color ? color.clone() : new THREE.Color(0xffffff);
}

function cacheFor(mesh: THREE.Mesh): GeneratedMaterialCache {
  let cache = generatedMaterialCache.get(mesh);
  if (!cache) {
    cache = {};
    generatedMaterialCache.set(mesh, cache);
  }
  return cache;
}

function facesMaterialFor(mesh: THREE.Mesh, original: THREE.Material | THREE.Material[] | undefined): THREE.MeshLambertMaterial {
  const cache = cacheFor(mesh);
  if (!cache.faces) cache.faces = new THREE.MeshLambertMaterial({ color: originalColorOf(original) });
  return cache.faces;
}

function wireframeMaterialFor(mesh: THREE.Mesh, original: THREE.Material | THREE.Material[] | undefined): THREE.MeshBasicMaterial {
  const cache = cacheFor(mesh);
  if (!cache.wireframe) cache.wireframe = new THREE.MeshBasicMaterial({ color: originalColorOf(original), wireframe: true });
  return cache.wireframe;
}

/**
 * Merges every mesh's vertex positions (transformed into `model.object`'s
 * local space, so nested-transform sub-meshes still land correctly) into
 * one `THREE.Points`. Built lazily, on first `'points'` selection, and
 * cached on `model.repr.points` — a glTF model with many meshes shouldn't
 * pay this cost on every load, only if points mode is actually used.
 */
function buildGltfPoints(model: Model3D): THREE.Points {
  model.object.updateMatrixWorld(true);
  const inverseRoot = new THREE.Matrix4().copy(model.object.matrixWorld).invert();
  const positions: number[] = [];
  const v = new THREE.Vector3();

  model.object.traverse((child) => {
    if (!isMesh(child)) return;
    const posAttr = child.geometry?.getAttribute('position');
    if (!posAttr) return;
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i);
      v.applyMatrix4(child.matrixWorld);
      v.applyMatrix4(inverseRoot);
      positions.push(v.x, v.y, v.z);
    }
  });

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: 0x88ccff, size: 2, sizeAttenuation: true });
  return new THREE.Points(geom, material);
}

function applyGltfRenderMode(model: Model3D, mode: RenderMode): void {
  const showPoints = mode === 'points';

  model.object.traverse((child) => {
    if (!isMesh(child)) return;
    child.visible = !showPoints;
    if (showPoints) return;

    const original = model.repr.originalMaterials.get(child);
    if (mode === 'textured') {
      if (original) child.material = original;
    } else if (mode === 'faces') {
      child.material = facesMaterialFor(child, original);
    } else if (mode === 'wireframe') {
      child.material = wireframeMaterialFor(child, original);
    }
  });

  if (showPoints) {
    if (!model.repr.points) {
      model.repr.points = buildGltfPoints(model);
      model.object.add(model.repr.points);
    }
    model.repr.points.visible = true;
  } else if (model.repr.points) {
    model.repr.points.visible = false;
  }
}

/**
 * Switches `model`'s visible representation to `mode`, building/caching
 * whatever's needed lazily (glTF's flat faces/wireframe materials and its
 * points representation). Falls back to `defaultRenderMode(model)` if `mode`
 * isn't in `supportedRenderModes(model)`, rather than throwing or rendering
 * nothing — mirrors the "disable, don't hide, with auto-fallback" UI pattern
 * both consuming projects use around a `<select>` of render modes.
 */
export function applyRenderMode(model: Model3D, mode: RenderMode): void {
  const supported = supportedRenderModes(model);
  const effective = supported.includes(mode) ? mode : defaultRenderMode(model);
  if (model.source === 'gltf') applyGltfRenderMode(model, effective);
  else applyPolygonRenderMode(model, effective);
}

import * as THREE from 'three';
import type { Model3D } from './types.js';
import type { RenderMode } from './render-modes.js';

/**
 * A shading override applied on top of whichever `RenderMode` is active.
 * `'lit'` is the no-op case — each mesh keeps its own real material,
 * flat/smooth-shaded per `smooth`. The other four swap in one generated
 * material per mesh: `'unlit'` (the original texture with no lighting),
 * `'normals'`/`'depth'` (debug views with no texture at all), and `'toon'`
 * (a cel-shaded pass, still textured). Meaningless for a polygon model (its
 * faces representation has no per-vertex-color lighting model to override)
 * and for `renderMode === 'wireframe' | 'points'` (those already render
 * flat/unlit by construction — see `render-modes.ts`).
 */
export type MeshShadingMode = 'lit' | 'unlit' | 'normals' | 'depth' | 'toon';

/**
 * Per-mesh generated shading materials, owned by the caller (`session.ts`)
 * so it controls exactly when they're disposed — on every appearance
 * refresh (before rebuilding) and on model switch/session dispose. A plain
 * `Map` rather than a `WeakMap`: callers need to iterate it to dispose
 * every entry, which a `WeakMap` can't do.
 */
export type GeneratedShadingMaterials = Map<THREE.Mesh, THREE.Material[]>;

function isMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as { isMesh?: boolean }).isMesh === true;
}

function materialColor(material: THREE.Material): THREE.Color {
  return (material as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color(0xffffff);
}

function materialMap(material: THREE.Material): THREE.Texture | null {
  return (material as THREE.MeshStandardMaterial).map ?? null;
}

function buildShadingMaterial(
  original: THREE.Material,
  shading: Exclude<MeshShadingMode, 'lit'>,
  smooth: boolean,
): THREE.Material {
  const common = {
    color: materialColor(original),
    side: original.side,
    transparent: original.transparent,
    opacity: original.opacity,
    alphaTest: original.alphaTest,
  };
  if (shading === 'unlit') return new THREE.MeshBasicMaterial({ ...common, map: materialMap(original) });
  if (shading === 'normals') return new THREE.MeshNormalMaterial({ side: original.side, flatShading: !smooth });
  if (shading === 'depth') return new THREE.MeshDepthMaterial({ side: original.side });
  return new THREE.MeshToonMaterial({ ...common, map: materialMap(original) });
}

/** Disposes every material `applyMeshShading` has generated into `cache` and empties it. Safe to call on an empty cache. */
export function clearGeneratedShadingMaterials(cache: GeneratedShadingMaterials): void {
  for (const materials of cache.values()) for (const material of materials) material.dispose();
  cache.clear();
}

/**
 * Applies `opts.shading` (tinted by `opts.smooth`) across every mesh in a
 * glTF `Model3D`, rebuilding `cache` from scratch each call — cheap enough
 * (plain material construction, no geometry work) that caching across calls
 * isn't worth the staleness risk when `smooth`/the underlying texture
 * changes. `'lit'` restores each mesh's own real material and only toggles
 * `flatShading`; the other four swap in one shared-shape material per mesh.
 * No-op for a polygon model, and for `opts.renderMode === 'wireframe' |
 * 'points'` — see `MeshShadingMode`'s doc comment for why.
 */
export function applyMeshShading(
  model: Model3D,
  cache: GeneratedShadingMaterials,
  opts: { shading: MeshShadingMode; smooth: boolean; renderMode: RenderMode },
): void {
  if (model.source !== 'gltf') return;
  clearGeneratedShadingMaterials(cache);

  const custom = opts.shading !== 'lit' && opts.renderMode !== 'wireframe' && opts.renderMode !== 'points';

  model.object.traverse((object) => {
    if (!isMesh(object)) return;
    const mesh = object;
    const base = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    if (!custom) {
      for (const material of base) if ('flatShading' in material) {
        (material as THREE.MeshStandardMaterial).flatShading = !opts.smooth;
        material.needsUpdate = true;
      }
      return;
    }

    const generated = base.map((material) =>
      buildShadingMaterial(material, opts.shading as Exclude<MeshShadingMode, 'lit'>, opts.smooth),
    );
    cache.set(mesh, generated);
    mesh.material = Array.isArray(mesh.material) ? generated : generated[0]!;
  });
}

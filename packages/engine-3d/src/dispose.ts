import * as THREE from 'three';
import { texturesOf } from './three-utils.js';

type DisposableRenderable = (THREE.Mesh | THREE.SkinnedMesh | THREE.Points | THREE.LineSegments) & {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
};

/**
 * Duck-types anything with a `geometry`+`material` pair worth disposing —
 * `Mesh`, `SkinnedMesh` (which `isMesh` is also true for), `Points`,
 * `LineSegments` (and `Line`, which shares `LineSegments`' shape) — via
 * three.js's own `is*` boolean flags rather than a hard `instanceof
 * THREE.Mesh`. Flower's original `disposeMeshTree` only checked
 * `instanceof THREE.Mesh`, silently skipping `Points`/`LineSegments`
 * representations (this package builds both, see `render-modes.ts`).
 */
function isDisposableRenderable(obj: THREE.Object3D): obj is DisposableRenderable {
  const o = obj as unknown as {
    isMesh?: boolean;
    isPoints?: boolean;
    isLineSegments?: boolean;
    isLine?: boolean;
  };
  return !!(o.isMesh || o.isPoints || o.isLineSegments || o.isLine);
}

/**
 * Disposes every texture referenced by `material`'s own properties, then
 * the material itself. Unlike flower's original fixed list
 * (`map`/`normalMap`/`emissiveMap`/`metalnessMap`/`roughnessMap`/`aoMap`,
 * and only for `MeshStandardMaterial`), `texturesOf` walks every own
 * enumerable property of *any* material class — see its doc comment.
 */
function disposeMaterial(material: THREE.Material): void {
  for (const texture of texturesOf(material)) texture.dispose();
  material.dispose();
}

/**
 * Disposes one mesh's material slot (a single `Material`, or every entry of
 * a multi-material `Material[]`) plus every texture each one references —
 * see `disposeMaterial`. Exported so a caller holding onto a material/array
 * outside a live scene graph (e.g. `session.ts`'s `clearTracked`, disposing
 * `ModelRepresentations.originalMaterials` — materials `disposeObject3D`
 * itself never sees once a render mode has swapped in a substitute) can
 * still release it correctly. Safe to call more than once on the same
 * material/texture (both `THREE.Material.dispose()` and `THREE.Texture.dispose()`
 * just dispatch a `'dispose'` event — a double-dispose is a harmless no-op,
 * not an error), so callers don't need to track what's already been freed
 * elsewhere.
 */
export function disposeMaterials(material: THREE.Material | THREE.Material[]): void {
  const materials = Array.isArray(material) ? material : [material];
  for (const m of materials) {
    if (m) disposeMaterial(m);
  }
}

/**
 * Disposes GPU resources (geometry + materials + every texture referenced
 * by those materials) for every disposable renderable under `obj`, so
 * switching models doesn't leak WebGL memory. Generalizes flower's
 * `disposeMeshTree` (`viewer.ts:1036-1051`) — see `isDisposableRenderable`
 * and `disposeMaterial` for the two respects in which this is broader —
 * and fixes hunter's current total absence of disposal (`meshGroup.clear()`
 * drops references without releasing anything).
 */
export function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (!isDisposableRenderable(child)) return;
    child.geometry?.dispose();
    if (child.material) disposeMaterials(child.material);
  });
}

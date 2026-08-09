import * as THREE from 'three';

type Disposable = { dispose(): void };
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

function isTexture(value: unknown): value is THREE.Texture & Disposable {
  return (
    !!value && typeof value === 'object' && (value as { isTexture?: boolean }).isTexture === true
  );
}

/**
 * Disposes every texture referenced by `material`'s own properties. Unlike
 * flower's original fixed list (`map`/`normalMap`/`emissiveMap`/
 * `metalnessMap`/`roughnessMap`/`aoMap`, and only for
 * `MeshStandardMaterial`), this walks all own enumerable properties of
 * *any* material class and disposes whichever ones turn out to be textures
 * (`.isTexture === true`) — so a `MeshBasicMaterial`'s `map`, a
 * `MeshPhysicalMaterial`'s `clearcoatMap`/`sheenColorMap`/etc, or any other
 * material's texture slots all get released without this file needing to
 * know every material class's field names.
 */
function disposeMaterial(material: THREE.Material): void {
  for (const key of Object.keys(material)) {
    const value = (material as unknown as Record<string, unknown>)[key];
    if (isTexture(value)) value.dispose();
  }
  material.dispose();
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
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material) disposeMaterial(material);
    }
  });
}

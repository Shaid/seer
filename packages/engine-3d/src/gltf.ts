import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Model3D, ModelRepresentations } from './types.js';

function isMesh(obj: THREE.Object3D): obj is THREE.Mesh | THREE.SkinnedMesh {
  return (obj as { isMesh?: boolean }).isMesh === true;
}

function materialHasMap(material: THREE.Material): boolean {
  // Not every material class has a `.map` (e.g. `MeshBasicMaterial` does,
  // `LineBasicMaterial` doesn't) — duck-type rather than checking specific
  // material classes, same rationale as `dispose.ts`'s texture walk.
  const map = (material as { map?: unknown }).map;
  return !!map && typeof map === 'object' && (map as { isTexture?: boolean }).isTexture === true;
}

/**
 * Converts a loaded glTF document into the package's canonical `Model3D`.
 * Captures each mesh's original material (for `render-modes.ts`'s
 * `'textured'` mode to restore later) and whether *any* mesh carries a real
 * texture map, entirely via duck-typing — nothing here assumes a specific
 * material class.
 */
export function toModel3D(gltf: Pick<GLTF, 'scene' | 'animations'>): Model3D {
  const object = gltf.scene;
  const originalMaterials: ModelRepresentations['originalMaterials'] = new Map();
  let hasTextures = false;

  object.traverse((child) => {
    if (!isMesh(child)) return;
    originalMaterials.set(child, child.material);
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material && materialHasMap(material)) hasTextures = true;
    }
  });

  const repr: ModelRepresentations = {
    faces: null,
    lines: null,
    points: null,
    originalMaterials,
  };

  return {
    object,
    source: 'gltf',
    animations: gltf.animations ?? [],
    hasTextures,
    repr,
  };
}

/**
 * Loads a glTF document from `url` and converts it to a `Model3D` — the
 * "no manual path plumbing at all" integration flower's original comment
 * describes (`viewer.ts:993-998`): `GLTFLoader` resolves the glTF's own
 * relative `images[]`/`buffers[]` URIs against `url` itself.
 */
export async function loadGltfModel(url: string, loader?: GLTFLoader): Promise<Model3D> {
  const gltf = await (loader ?? new GLTFLoader()).loadAsync(url);
  return toModel3D(gltf);
}

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Model3D, ModelRepresentations } from './types.js';
import { isMesh, isTexture } from './three-utils.js';

/**
 * Whether `material` has a real base-colour texture bound. Not every
 * material class even has a `.map` (`MeshBasicMaterial` does,
 * `LineBasicMaterial` doesn't), so this duck-types the slot's value rather
 * than branching on the material class.
 */
function materialHasMap(material: THREE.Material): boolean {
  return isTexture((material as { map?: unknown }).map);
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

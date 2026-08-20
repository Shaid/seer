import * as THREE from 'three';
import type { Model3D } from './types.js';

/**
 * How a GPU samples a texture that doesn't map 1:1 to screen pixels.
 * `'nearest'` is the crisp/blocky point-sampled look with no mipmaps —
 * matches the viewer's indexed-shader 2D sprite view, and the natural
 * default for a low-res PSX-era texture. `'linear'` bilinear-filters
 * without mipmaps (smooth up close, shimmery/aliased at a distance).
 * `'trilinear'` additionally generates and blends between mipmap levels —
 * smoothest at any distance, at the cost of a one-time mipmap-generation
 * pass per texture and more GPU memory.
 */
export type TextureFilterMode = 'nearest' | 'linear' | 'trilinear';

export interface TextureFilterOptions {
  mode: TextureFilterMode;
  /**
   * Anisotropic filtering sample count — sharpens a texture viewed at a
   * grazing angle (e.g. a floor stretching to the horizon). `1` disables it.
   * Ignored (forced to `1`) for `'nearest'`, which has no mipmap chain for
   * anisotropic sampling to blend across. Values above `maxAnisotropy` (see
   * `applyTextureFilter`) are clamped down to it.
   */
  anisotropy?: number;
}

const FILTER_PARAMS: Record<
  TextureFilterMode,
  { mag: THREE.MagnificationTextureFilter; min: THREE.MinificationTextureFilter; mipmaps: boolean }
> = {
  nearest: { mag: THREE.NearestFilter, min: THREE.NearestFilter, mipmaps: false },
  linear: { mag: THREE.LinearFilter, min: THREE.LinearFilter, mipmaps: false },
  trilinear: { mag: THREE.LinearFilter, min: THREE.LinearMipmapLinearFilter, mipmaps: true },
};

function isTexture(value: unknown): value is THREE.Texture {
  return !!value && typeof value === 'object' && (value as { isTexture?: boolean }).isTexture === true;
}

/**
 * Every texture referenced by any of `material`'s own properties, duck-typed
 * the same way `dispose.ts`'s `disposeMaterial` walks a material's texture
 * slots — works across material classes without a fixed
 * `map`/`normalMap`/`roughnessMap`/... field list.
 */
function texturesOf(material: THREE.Material): THREE.Texture[] {
  const found: THREE.Texture[] = [];
  for (const key of Object.keys(material)) {
    const value = (material as unknown as Record<string, unknown>)[key];
    if (isTexture(value)) found.push(value);
  }
  return found;
}

/**
 * Applies `options` to every texture referenced by `model`'s *original*
 * glTF materials — not just whichever material is currently assigned to a
 * mesh, so a filter chosen while `'faces'`/`'wireframe'`/a custom shading
 * mode is active still takes effect the moment the host switches back to
 * `'textured'` or `'unlit'`, with no second re-application needed. No-op
 * for a polygon model (no texture data at all — see
 * `render-modes.ts`'s `supportedRenderModes`).
 */
export function applyTextureFilter(model: Model3D, options: TextureFilterOptions, maxAnisotropy = 1): void {
  if (model.source !== 'gltf') return;
  const params = FILTER_PARAMS[options.mode];
  const anisotropy =
    options.mode === 'nearest' ? 1 : Math.max(1, Math.min(options.anisotropy ?? 1, maxAnisotropy));

  const seen = new Set<THREE.Texture>();
  for (const materials of model.repr.originalMaterials.values()) {
    const list = Array.isArray(materials) ? materials : [materials];
    for (const material of list) {
      for (const texture of texturesOf(material)) {
        if (seen.has(texture)) continue;
        seen.add(texture);
        texture.magFilter = params.mag;
        texture.minFilter = params.min;
        texture.generateMipmaps = params.mipmaps;
        texture.anisotropy = anisotropy;
        texture.needsUpdate = true;
      }
    }
  }
}

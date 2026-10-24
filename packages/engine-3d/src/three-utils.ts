/**
 * Internal three.js duck-typing guards and one-liners shared across this
 * package. **Not exported from `index.ts`** — these are implementation
 * details, not part of the package's public surface.
 *
 * Everything here duck-types on three.js's own `is*` boolean flags rather
 * than `instanceof`. That matters for two reasons: a scene graph can carry
 * objects built by a differently-bundled copy of three (where `instanceof`
 * fails across realms), and it keeps these guards working for subclasses
 * (`SkinnedMesh` sets `isMesh`) without naming each one.
 */
import * as THREE from 'three';

/** Whether `obj` is a `Mesh` — true for `SkinnedMesh` and any other subclass too. */
export function isMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as { isMesh?: boolean }).isMesh === true;
}

/** Whether `value` is a three.js `Texture`. */
export function isTexture(value: unknown): value is THREE.Texture {
  return !!value && typeof value === 'object' && (value as { isTexture?: boolean }).isTexture === true;
}

/**
 * Every texture referenced by any of `material`'s own enumerable
 * properties. Walking the properties — rather than a fixed
 * `map`/`normalMap`/`roughnessMap`/... field list — covers every material
 * class's texture slots without this package needing to know their names:
 * a `MeshBasicMaterial`'s `map`, a `MeshPhysicalMaterial`'s
 * `clearcoatMap`/`sheenColorMap`, and anything a future class adds.
 */
export function texturesOf(material: THREE.Material): THREE.Texture[] {
  const found: THREE.Texture[] = [];
  for (const key of Object.keys(material)) {
    const value = (material as unknown as Record<string, unknown>)[key];
    if (isTexture(value)) found.push(value);
  }
  return found;
}

/**
 * A material's base `.color`, cloned so the caller can't mutate the
 * material through it. Falls back to white for a material class that has no
 * `.color` at all; a `Material[]` slot resolves to its first entry, matching
 * how a multi-material mesh's "primary" colour has always been read here.
 */
export function materialBaseColor(material: THREE.Material | THREE.Material[] | undefined): THREE.Color {
  const mat = Array.isArray(material) ? material[0] : material;
  const color = (mat as { color?: THREE.Color } | undefined)?.color;
  return color ? color.clone() : new THREE.Color(0xffffff);
}

/** Clamp to the unit interval. `NaN` passes through unchanged, as with `Math.min`/`Math.max`. */
export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

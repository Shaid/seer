import * as THREE from 'three';
import type { Model3D } from './types.js';
import type { RenderMode } from './render-modes.js';

/**
 * A shading override applied on top of whichever `RenderMode` is active.
 * `'lit'` is the no-op case — each mesh keeps its own real material,
 * flat/smooth-shaded per `smooth`. The other five swap in one generated
 * material per mesh: `'unlit'` (the original texture with no lighting),
 * `'normals'`/`'depth'` (debug views with no texture at all), `'toon'`
 * (a cel-shaded pass, still textured, using three.js's built-in 2-band
 * fallback ramp), and `'indexedRamp'` (a second, harder-edged cel-shaded
 * pass approximating Fire Emblem: Three Houses's real
 * `KTGL_FX_SHADING_MESH_PHYSICALLY_BASED2_INDEXED_RAMP` toon-ramp shader —
 * see `buildShadingMaterial`'s doc comment for exactly what's a real
 * reproduction vs. an engineering approximation). Meaningless for a
 * polygon model (its faces representation has no per-vertex-color lighting
 * model to override) and for `renderMode === 'wireframe' | 'points'`
 * (those already render flat/unlit by construction — see
 * `render-modes.ts`).
 */
export type MeshShadingMode = 'lit' | 'unlit' | 'normals' | 'depth' | 'toon' | 'indexedRamp';

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

function materialNormalMap(material: THREE.Material): THREE.Texture | null {
  return (material as THREE.MeshStandardMaterial).normalMap ?? null;
}

function materialAoMap(material: THREE.Material): THREE.Texture | null {
  return (material as THREE.MeshStandardMaterial).aoMap ?? null;
}

/**
 * Lazily-built, module-shared 4-band toon ramp texture for `'indexedRamp'`
 * shading — never disposed by `applyMeshShading`/`clearGeneratedShadingMaterials`
 * (they only dispose the *materials* they generate, never a material's
 * texture properties, matching three.js's own `Material.dispose()`
 * contract; see this function's callers) and cheap enough (4x1 px) that
 * leaving it live for the process lifetime is a non-issue.
 *
 * **Engineering approximation, not a reproduction.** The real game's
 * `KTGL_FX_SHADING_MESH_PHYSICALLY_BASED2_INDEXED_RAMP` shader samples an
 * actual ramp texture/atlas via `rampIndex`/`rampCoordBias`/`Range`/
 * `Scaler` (see `docs/fe-threehouses.md`'s "Shading pipeline" section in
 * the `chimera` project) — no such texture was ever located in the shipped
 * asset corpus, and the coordinate-remap constants were never extracted
 * from the executable. Four hand-picked bands loosely mirror the shader's
 * two-band `HL`/`HH` parameter naming (a dark shadow band, two mid bands,
 * a bright highlight) without reproducing its real curve.
 */
let indexedRampGradient: THREE.DataTexture | null = null;
function getIndexedRampGradient(): THREE.DataTexture {
  if (indexedRampGradient) return indexedRampGradient;
  const bands = new Uint8Array([60, 140, 200, 255]);
  const texture = new THREE.DataTexture(bands, bands.length, 1, THREE.RedFormat, THREE.UnsignedByteType);
  // NearestFilter keeps the bands hard-edged — required for a stepped toon
  // ramp; three.js's own MeshToonMaterial docs make the same point (a
  // linear-filtered gradientMap just reproduces smooth Lambertian shading).
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  indexedRampGradient = texture;
  return texture;
}

/**
 * FE3H's REAL toon-ramp LUT texture (`DATA0[552]` texture slot 0, a
 * 256x256 RGBA8 image — see `docs/fe-threehouses.md`'s "Shading pipeline
 * follow-up, part 3", 2026-09-07 `re-oracle` escalation, in the `chimera`
 * project), registered once by the host viewer — this package has no
 * asset-fetching of its own, so it's the caller's job to fetch/decode the
 * shipped `toon_ramp_lut.png` and hand over raw pixel data via
 * {@link setToonRampLutImage}. `null` until registered (or after
 * `setToonRampLutImage(null)`), in which case `'indexedRamp'` falls back to
 * `getIndexedRampGradient()`'s synthetic approximation exactly as before —
 * every existing caller that never registers a LUT image gets byte-
 * identical behavior to before this was added.
 */
interface ToonRampLutImage {
  width: number;
  height: number;
  /** Tightly-packed RGBA8, row-major, length `width * height * 4`. */
  data: Uint8ClampedArray | Uint8Array;
}
let toonRampLutImage: ToonRampLutImage | null = null;
const toonRampRowTextureCache = new Map<number, THREE.DataTexture>();

export function setToonRampLutImage(image: ToonRampLutImage | null): void {
  toonRampLutImage = image;
  for (const texture of toonRampRowTextureCache.values()) texture.dispose();
  toonRampRowTextureCache.clear();
}

/**
 * The real per-row toon-ramp curve for a G1M material's `SEER_toon_ramp_index`
 * (1-based; the real shader's row is `rampIndex - 1` — see that extra's doc
 * comment in `gltf-builder.ts`, `chimera` project), sliced from the
 * registered LUT image and cached per row index (a corpus has at most a few
 * dozen distinct real values, never one per material instance, so this
 * cache stays small for the life of the page). `null` when no LUT is
 * registered or `rampIndex` is out of the image's row range.
 *
 * Stores per-texel LUMINANCE (the mean of R/G/B) in a single-channel
 * texture, not the LUT's real full-color RGB: three.js's stock toon shader
 * (`gradientmap_pars_fragment.glsl.js`) only ever reads `gradientMap`'s `.r`
 * channel — reproducing a colour-tinted row (e.g. a purple-tinted face-pack
 * ramp) would need a custom fragment-shader patch this pass didn't add (see
 * `addIndexedRampRimLight` for the technique, if a future pass wants it).
 * This still recovers the real per-row shadow/highlight TRANSITION CURVE —
 * the part that actually shapes a toon-shaded silhouette — which is a real,
 * measured improvement over `getIndexedRampGradient()`'s 4 hand-picked
 * band values, just not a full color reproduction.
 */
function getRealRampGradient(rampIndex: number): THREE.DataTexture | null {
  if (!toonRampLutImage) return null;
  const cached = toonRampRowTextureCache.get(rampIndex);
  if (cached) return cached;
  const row = rampIndex - 1;
  if (row < 0 || row >= toonRampLutImage.height) return null;
  const { width, data } = toonRampLutImage;
  const luminance = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    const o = (row * width + x) * 4;
    luminance[x] = Math.round((data[o]! + data[o + 1]! + data[o + 2]!) / 3);
  }
  const texture = new THREE.DataTexture(luminance, width, 1, THREE.RedFormat, THREE.UnsignedByteType);
  // LinearFilter here (unlike the synthetic fallback's NearestFilter): the
  // real LUT is a genuine smooth photographic ramp, not a stepped band set
  // — see the visual dump cited in the docs section above.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  toonRampRowTextureCache.set(rampIndex, texture);
  return texture;
}

/**
 * Adds a view-dependent Fresnel rim-light term to an already-constructed
 * `MeshToonMaterial`, via `onBeforeCompile` (three.js's supported hook for
 * exactly this — no shader is hand-assembled from scratch). Approximates
 * the real shader's `rampRimColorAdj`/`rampRimFade`/`rampRimThres` +
 * `rampSecondaryRimPackedParams` two-channel rim system (see
 * `docs/fe-threehouses.md`) with a single fixed-color, fixed-power term —
 * the real per-material rim colour/threshold constants were never
 * extracted. Reads `normal` (already normal-mapped, if a normal map is
 * bound) and `vViewPosition`, both already in scope at the injection point
 * in three.js's `meshtoon` fragment shader — verified against the vendored
 * `three@0.185` shader chunk source, not guessed from the stock material's
 * public API.
 */
function addIndexedRampRimLight(material: THREE.MeshToonMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: new THREE.Color(0xffffff) };
    shader.uniforms.rimPower = { value: 2.5 };
    shader.uniforms.rimIntensity = { value: 0.35 };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 rimColor;\nuniform float rimPower;\nuniform float rimIntensity;',
      )
      .replace(
        '#include <dithering_fragment>',
        `{
          float rimDot = 1.0 - max( dot( normalize( vViewPosition ), normal ), 0.0 );
          float rim = pow( rimDot, rimPower ) * rimIntensity;
          gl_FragColor.rgb += rimColor * rim;
        }
        #include <dithering_fragment>`,
      );
  };
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
  if (shading === 'indexedRamp') {
    // `SEER_toon_ramp_index` — see `gltf-builder.ts` (`chimera` project) —
    // is copied verbatim from the glTF material's `extras` into `userData`
    // by `GLTFLoader.loadMaterial` (`assignExtrasToUserData`, confirmed
    // against the vendored `three` source, not assumed). Real data wins
    // over the synthetic fallback whenever both a rampIndex and a
    // registered LUT image are available for this material.
    const rampIndex = (original.userData as { SEER_toon_ramp_index?: number } | undefined)?.SEER_toon_ramp_index;
    const gradientMap = (rampIndex !== undefined && getRealRampGradient(rampIndex)) || getIndexedRampGradient();
    const material = new THREE.MeshToonMaterial({
      ...common,
      map: materialMap(original),
      normalMap: materialNormalMap(original),
      aoMap: materialAoMap(original),
      gradientMap,
    });
    addIndexedRampRimLight(material);
    return material;
  }
  return new THREE.MeshToonMaterial({ ...common, map: materialMap(original) });
}

/** Disposes every material `applyMeshShading` has generated into `cache` and empties it. Safe to call on an empty cache. */
export function clearGeneratedShadingMaterials(cache: GeneratedShadingMaterials): void {
  for (const materials of cache.values()) for (const material of materials) material.dispose();
  cache.clear();
}

/**
 * Applies `opts.shading` (tinted by `opts.smooth`) across every mesh in a
 * glTF `Model3D`, rebuilding this model's own entries in `cache` from
 * scratch each call — cheap enough (plain material construction, no
 * geometry work) that caching across calls isn't worth the staleness risk
 * when `smooth`/the underlying texture changes. `'lit'` restores each
 * mesh's own real material and only toggles `flatShading`; the other five
 * swap in one shared-shape material per mesh. No-op for a polygon model,
 * and for `opts.renderMode === 'wireframe' | 'points'` — see
 * `MeshShadingMode`'s doc comment for why.
 *
 * Only disposes/evicts `model`'s OWN previously-generated entries from
 * `cache`, not the whole cache — `cache` is shared across every model in a
 * `MeshSession` (see `session.ts`'s `refreshAppearance`, which calls this
 * once per tracked model against the same cache instance), so a full
 * `clearGeneratedShadingMaterials(cache)` here would dispose materials a
 * sibling model's own call had just built moments earlier in the same
 * refresh pass. Use `clearGeneratedShadingMaterials` directly for an actual
 * full-cache teardown (session switch/dispose).
 */
export function applyMeshShading(
  model: Model3D,
  cache: GeneratedShadingMaterials,
  opts: { shading: MeshShadingMode; smooth: boolean; renderMode: RenderMode },
): void {
  if (model.source !== 'gltf') return;
  model.object.traverse((object) => {
    if (!isMesh(object)) return;
    const stale = cache.get(object);
    if (!stale) return;
    for (const material of stale) material.dispose();
    cache.delete(object);
  });

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

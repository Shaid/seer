import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** One placed instance of a named mesh — flower's `ScenePlacementData`, generalized (`objectPath`/`meshObjectName` stay project-local, they're PS3-package provenance, not something this package needs to know about). */
export interface Placement {
  /** The name a mesh is loaded/deduplicated by — resolved to a URL via the host-supplied `resolveUrl`. */
  mesh: string;
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface PlacedSceneResult {
  /** Placements actually instantiated (their mesh loaded successfully). */
  placed: number;
  totalPlacements: number;
  /** Distinct mesh names referenced by `placements`. */
  uniqueMeshes: number;
  /** Distinct meshes that failed to load — each failure drops every placement referencing it, but doesn't stop the rest (per-mesh failure tolerance). */
  meshLoadFailures: number;
}

export interface LoadPlacedSceneOptions {
  loader?: GLTFLoader;
}

/**
 * Loads and assembles a placed scene: flower's scene-assembly logic
 * (`viewer.ts:1370-1417`) — dedupe by mesh name, load every distinct mesh in
 * parallel, tolerate individual mesh load failures, and `.clone()` (sharing
 * geometry/material buffers, not a deep clone) + transform one instance per
 * placement. `resolveUrl` is the injection point that replaces flower's
 * hardcoded `` `${ASSET_BASE}/meshes/${name}.gltf` `` — the host still owns
 * that naming convention, just expressed as a callback instead of baked in.
 */
export async function loadPlacedScene(
  root: THREE.Object3D,
  placements: Placement[],
  resolveUrl: (meshName: string) => string,
  opts: LoadPlacedSceneOptions = {},
): Promise<PlacedSceneResult> {
  const loader = opts.loader ?? new GLTFLoader();
  const uniqueMeshNames = [...new Set(placements.map((p) => p.mesh))];
  const loadedByName = new Map<string, THREE.Object3D>();
  let meshLoadFailures = 0;

  await Promise.all(
    uniqueMeshNames.map(async (name) => {
      try {
        const gltf = await loader.loadAsync(resolveUrl(name));
        loadedByName.set(name, gltf.scene);
      } catch (err) {
        meshLoadFailures++;
        console.warn(`loadPlacedScene: failed to load mesh "${name}":`, err);
      }
    }),
  );

  let placed = 0;
  for (const placement of placements) {
    const template = loadedByName.get(placement.mesh);
    if (!template) continue;
    const instance = template.clone();
    instance.position.fromArray(placement.translation);
    instance.quaternion.set(
      placement.rotation[0],
      placement.rotation[1],
      placement.rotation[2],
      placement.rotation[3],
    );
    instance.scale.fromArray(placement.scale);
    root.add(instance);
    placed++;
  }

  return {
    placed,
    totalPlacements: placements.length,
    uniqueMeshes: uniqueMeshNames.length,
    meshLoadFailures,
  };
}

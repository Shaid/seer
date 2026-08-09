import * as THREE from 'three';

export interface MeshStats {
  verts: number;
  tris: number;
}

function isMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as { isMesh?: boolean }).isMesh === true;
}

/**
 * Counts vertices/triangles under `object` — flower's `meshStats`
 * (`viewer.ts:1084-1095`) verbatim, with one addition: it skips any mesh
 * that's currently `.visible === false`. Flower only ever had one mesh
 * representation live at a time, so that check was never needed there; this
 * package builds faces/lines/points as sibling representations toggled by
 * `render-modes.ts` (only one visible at once), and without the check a
 * hidden representation's geometry would get double-counted into the
 * reported stats.
 */
export function meshStats(object: THREE.Object3D): MeshStats {
  let verts = 0;
  let tris = 0;
  object.traverse((child) => {
    if (!isMesh(child) || !child.visible) return;
    const pos = child.geometry.getAttribute('position');
    if (!pos) return;
    verts += pos.count;
    tris += child.geometry.index ? child.geometry.index.count / 3 : pos.count / 3;
  });
  return { verts, tris: Math.round(tris) };
}

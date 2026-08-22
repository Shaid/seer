import * as THREE from 'three';

/**
 * The seam that makes the viewport's draw call swappable across render
 * tiers (`flat` / `cinematic` / `photo`, see `render-quality-proposal.md`)
 * without touching the `onFrame`/frame-limiter contract in `viewport.ts`.
 * `null` installed on `Viewport` means today's behavior — a plain
 * `renderer.render(scene, camera)` — so every existing consumer sees zero
 * change until a host explicitly opts into a tier.
 */
export interface RenderPath {
  /** Draws one frame. `deltaSeconds` is the real elapsed time since the
   *  last rendered frame (`0` for a `renderNow()`-driven capture, which
   *  isn't advancing any animation). */
  render(scene: THREE.Scene, camera: THREE.Camera, deltaSeconds: number): void;
  /** Called from `Viewport.resize()`, after the renderer/camera have
   *  already been resized — a path with its own offscreen render targets
   *  (a cinematic composer, a path tracer) resizes those here. */
  setSize?(width: number, height: number, pixelRatio: number): void;
  /** Called from `Viewport.setCamera()`, after `controls.object` has
   *  already been repointed — a path holding its own camera reference
   *  (a path tracer tracking a `PhysicalCamera`) updates it here. */
  setCamera?(camera: THREE.PerspectiveCamera): void;
  /** Scene geometry or materials changed underneath this path (a settings
   *  change rebuilt a mesh's geometry, swapped its materials, or replaced
   *  the model entirely) — rebuild any state derived from scene contents
   *  (a BVH, an accumulated path-traced image). No-op for a tier with
   *  nothing to invalidate (`cinematic`'s postprocessing chain doesn't
   *  care what the scene contains). */
  invalidateSceneContents?(): void;
  /** Releases whatever GPU/CPU resources this path holds — offscreen
   *  render targets, a path tracer's accumulation buffer, a BVH. Called by
   *  `Viewport.setRenderPath()` on the outgoing path, and by
   *  `Viewport.dispose()` on whatever path is currently installed. */
  dispose(): void;
}

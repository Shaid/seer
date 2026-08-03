/**
 * BaseCamera — the minimal contract `Game` requires of any camera.
 *
 * Deliberately tiny: a future first-person "camera" is a discrete grid pose
 * (position + facing on a dungeon grid), not an affine {x,y,zoom} transform,
 * and must not be forced to implement pan/zoom/moveTo just to plug into
 * `Game`. Anything beyond `kind` + `setViewSize` belongs on a concrete
 * camera type (e.g. `TopDownCamera`), not here.
 */
export interface BaseCamera {
  /** Discriminator for the kind of camera (e.g. 'top-down', 'side-view'). */
  readonly kind: string;
  /** Update the camera's notion of viewport/screen size in pixels. */
  setViewSize(width: number, height: number): void;
}

/**
 * SideViewCamera — a camera for side-on/profile-view content (e.g. a scene
 * where world content is laid out on an X/Y plane viewed from the side,
 * rather than a top-down map).
 *
 * Semantically distinct from `TopDownCamera` (what the world content
 * represents), but mathematically identical today (pan/zoom/clamp): extend
 * this independently only if a real divergent need shows up (e.g. parallax
 * layers), rather than speculatively diverging now.
 */
import { TopDownCamera } from './TopDownCamera.ts';

export class SideViewCamera extends TopDownCamera {
  override readonly kind: string = 'side-view';
}

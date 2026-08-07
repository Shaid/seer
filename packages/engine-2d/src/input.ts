/**
 * `@seer-project/engine-2d/input` — low-level, camera-agnostic input primitives.
 *
 * Exported as a separate subpath (mirroring `@seer-project/engine-2d/pixi-helpers`)
 * because `KeyState`/`PointerState` have zero dependency on `Camera`,
 * `TopDownCamera`, or `InputManager` and are useful standalone.
 */
export { KeyState } from './KeyState.ts';
export { PointerState } from './PointerState.ts';

/**
 * `bindings.json` — configurable key bindings for walker movement/actions.
 *
 * Defaults are **positional**, keyed by `KeyboardEvent.code` (e.g. `'KeyW'`,
 * `'ArrowUp'`) rather than by character. `code` names the physical key, so an
 * AZERTY user pressing the key labelled *Z* still reports `KeyW` — defaulting
 * in `code` space gives every keyboard layout the same WASD+QE finger
 * positions for free, rather than literally the same *letters* (which would
 * be a worse default for non-QWERTY users). See `walker-plan.md`, "Input and
 * keybindings (config-driven, positional)".
 *
 * `mode` is carried through for a future rebinding UI that wants to offer
 * genuine letter/character matching instead (`'literal'`) — nothing in
 * `@seer/dungeon` currently changes behaviour based on it, since
 * `WalkerController` only ever compares `KeyState`'s `.code` values against
 * this file's arrays regardless of `mode`. Actually switching to literal
 * (layout-aware) matching is out of scope for M3; `mode` is data for that
 * future UI, not a behavioural switch yet — documented here rather than
 * silently ignored.
 */

export type BindingAction =
  | 'forward'
  | 'back'
  | 'strafeLeft'
  | 'strafeRight'
  | 'turnLeft'
  | 'turnRight'
  | 'interact'
  | 'automap';

export const BINDING_ACTIONS: readonly BindingAction[] = [
  'forward',
  'back',
  'strafeLeft',
  'strafeRight',
  'turnLeft',
  'turnRight',
  'interact',
  'automap',
];

export interface BindingsFile {
  schemaVersion: 1;
  /** How bindings should be interpreted by a rebinding UI. Defaults to `'positional'`. */
  mode?: 'positional' | 'literal';
  /** Each action maps to the set of `KeyboardEvent.code` values that trigger it (any one suffices). */
  bindings: Record<BindingAction, string[]>;
}

/** Modern WASD + QE, all overridable — see the walker plan's Phase D. */
export const DEFAULT_BINDINGS: BindingsFile = {
  schemaVersion: 1,
  mode: 'positional',
  bindings: {
    forward: ['KeyW', 'ArrowUp'],
    back: ['KeyS', 'ArrowDown'],
    strafeLeft: ['KeyA'],
    strafeRight: ['KeyD'],
    turnLeft: ['KeyQ', 'ArrowLeft'],
    turnRight: ['KeyE', 'ArrowRight'],
    interact: ['Space'],
    automap: ['Tab'],
  },
};

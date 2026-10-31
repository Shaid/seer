/**
 * Logical arcade inputs as a per-player bitmask, and the plain-data
 * bindings that map keyboard codes and gamepad buttons onto them.
 *
 * The sim reads one number per player per step, so a replay is an array of
 * numbers and a regression test needs no DOM. Bits are logical (1 =
 * pressed); a port that mimics active-low input ports inverts them itself.
 */

export const ArcadeInput = {
  UP: 1 << 0,
  DOWN: 1 << 1,
  LEFT: 1 << 2,
  RIGHT: 1 << 3,
  BUTTON1: 1 << 4,
  BUTTON2: 1 << 5,
  BUTTON3: 1 << 6,
  BUTTON4: 1 << 7,
  START: 1 << 8,
  COIN: 1 << 9,
  /** A cabinet input; bind it to player 0 by convention. */
  SERVICE: 1 << 10,
} as const;

export type ArcadeInputName = keyof typeof ArcadeInput;

export const ARCADE_INPUT_NAMES = Object.keys(ArcadeInput) as ArcadeInputName[];

export function inputMask(...names: ArcadeInputName[]): number {
  let mask = 0;
  for (const name of names) mask |= ArcadeInput[name];
  return mask;
}

export function inputNames(mask: number): ArcadeInputName[] {
  return ARCADE_INPUT_NAMES.filter((name) => (mask & ArcadeInput[name]) !== 0);
}

/**
 * Clears both directions of an opposing pair held together (left+right,
 * up+down). A real 8-way joystick cannot report them, and original game
 * code often misbehaves when it sees them.
 */
export function cleanOpposingDirections(mask: number): number {
  if ((mask & ArcadeInput.LEFT) && (mask & ArcadeInput.RIGHT)) mask &= ~(ArcadeInput.LEFT | ArcadeInput.RIGHT);
  if ((mask & ArcadeInput.UP) && (mask & ArcadeInput.DOWN)) mask &= ~(ArcadeInput.UP | ArcadeInput.DOWN);
  return mask;
}

export interface InputBinding {
  /** 0-based player index. */
  player: number;
  input: ArcadeInputName;
}

export interface GamepadBinding {
  /** Which player this pad drives. */
  player: number;
  /** Standard-mapping button index → input. */
  buttons: Record<number, ArcadeInputName>;
  /** Left-stick axes (0 = x, 1 = y) count as directions past this magnitude; `0` disables. Default `0.5`. */
  axisThreshold?: number;
}

/** Plain, JSON-serialisable binding set — persist it as-is for a remap UI. */
export interface InputBindings {
  /** `KeyboardEvent.code` → binding. */
  keyboard: Record<string, InputBinding>;
  /** Indexed by `Gamepad.index`. */
  gamepads: GamepadBinding[];
}

const STANDARD_PAD_BUTTONS: Record<number, ArcadeInputName> = {
  0: 'BUTTON1',
  1: 'BUTTON2',
  2: 'BUTTON3',
  3: 'BUTTON4',
  8: 'COIN', // Select / Back / View
  9: 'START',
  12: 'UP',
  13: 'DOWN',
  14: 'LEFT',
  15: 'RIGHT',
};

/**
 * MAME's default keyboard layout, so the keys match what arcade players
 * already know: P1 arrows + LCtrl/LAlt/Space/LShift, P2 RFDG + A/S/Q/W,
 * `1`/`2` start, `5`/`6` coin, `9` service. Gamepads 0 and 1 drive P1 and P2
 * through the standard mapping.
 */
export function defaultInputBindings(): InputBindings {
  const kb = (player: number, input: ArcadeInputName): InputBinding => ({ player, input });
  return {
    keyboard: {
      ArrowUp: kb(0, 'UP'),
      ArrowDown: kb(0, 'DOWN'),
      ArrowLeft: kb(0, 'LEFT'),
      ArrowRight: kb(0, 'RIGHT'),
      ControlLeft: kb(0, 'BUTTON1'),
      AltLeft: kb(0, 'BUTTON2'),
      Space: kb(0, 'BUTTON3'),
      ShiftLeft: kb(0, 'BUTTON4'),
      Digit1: kb(0, 'START'),
      Digit5: kb(0, 'COIN'),
      Digit9: kb(0, 'SERVICE'),
      KeyR: kb(1, 'UP'),
      KeyF: kb(1, 'DOWN'),
      KeyD: kb(1, 'LEFT'),
      KeyG: kb(1, 'RIGHT'),
      KeyA: kb(1, 'BUTTON1'),
      KeyS: kb(1, 'BUTTON2'),
      KeyQ: kb(1, 'BUTTON3'),
      KeyW: kb(1, 'BUTTON4'),
      Digit2: kb(1, 'START'),
      Digit6: kb(1, 'COIN'),
    },
    gamepads: [
      { player: 0, buttons: { ...STANDARD_PAD_BUTTONS }, axisThreshold: 0.5 },
      { player: 1, buttons: { ...STANDARD_PAD_BUTTONS }, axisThreshold: 0.5 },
    ],
  };
}

/**
 * Binds `code` to `binding`, first removing any other key bound to the same
 * player+input when `exclusive` (default) — the usual "press a key for P1
 * Jump" remap. Returns a new bindings object.
 */
export function rebindKey(bindings: InputBindings, code: string, binding: InputBinding, exclusive = true): InputBindings {
  const keyboard: Record<string, InputBinding> = {};
  for (const [k, b] of Object.entries(bindings.keyboard)) {
    if (exclusive && b.player === binding.player && b.input === binding.input) continue;
    keyboard[k] = b;
  }
  keyboard[code] = { ...binding };
  return { ...bindings, keyboard };
}

/** Minimal slice of the Gamepad API the sampler reads, so tests can fake it. */
export interface GamepadLike {
  index: number;
  connected: boolean;
  buttons: readonly { pressed: boolean }[];
  axes: readonly number[];
}

/** Folds one gamepad's state into `masks` per `binding`. Pure. */
export function applyGamepad(masks: number[], pad: GamepadLike, binding: GamepadBinding): void {
  if (!pad.connected || binding.player >= masks.length) return;
  let mask = 0;
  for (const [idx, input] of Object.entries(binding.buttons)) {
    if (pad.buttons[Number(idx)]?.pressed) mask |= ArcadeInput[input];
  }
  const t = binding.axisThreshold ?? 0.5;
  if (t > 0) {
    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    if (x <= -t) mask |= ArcadeInput.LEFT;
    if (x >= t) mask |= ArcadeInput.RIGHT;
    if (y <= -t) mask |= ArcadeInput.UP;
    if (y >= t) mask |= ArcadeInput.DOWN;
  }
  masks[binding.player] |= mask;
}

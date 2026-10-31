/**
 * Input recording and playback. A replay is the per-step input masks plus
 * whatever the sim needs to start identically (DIP settings, a stage), all
 * plain JSON — so a replay file is also a regression test fixture.
 */

import { hashState } from './state.js';

export interface Replay<M = unknown> {
  version: 1;
  /** Masks per step. */
  players: number;
  /** `frames * players` masks, interleaved: step `f`, player `p` at `f * players + p`. */
  inputs: number[];
  /** Caller-defined start conditions (DIP settings, board hz, ROM set, …). */
  meta?: M;
}

export function replayLength(replay: Replay): number {
  return Math.floor(replay.inputs.length / replay.players);
}

export class InputRecorder {
  readonly players: number;
  private inputs: number[] = [];

  constructor(players = 2) {
    this.players = players;
  }

  get frames(): number {
    return this.inputs.length / this.players;
  }

  /** Records one step's masks (missing players record 0). */
  record(masks: readonly number[]): void {
    for (let p = 0; p < this.players; p++) this.inputs.push(masks[p] ?? 0);
  }

  /** Drops everything after `frame` steps — e.g. after a rewind, before recording on. */
  truncate(frame: number): void {
    this.inputs.length = Math.min(this.inputs.length, Math.max(0, frame) * this.players);
  }

  toReplay<M>(meta?: M): Replay<M> {
    const replay: Replay<M> = { version: 1, players: this.players, inputs: this.inputs.slice() };
    if (meta !== undefined) replay.meta = meta;
    return replay;
  }
}

export class ReplayPlayer {
  readonly replay: Replay;
  private _frame = 0;

  constructor(replay: Replay) {
    if (replay.version !== 1) throw new Error(`arcade-runtime: unsupported replay version ${String(replay.version)}`);
    if (!(replay.players >= 1)) throw new Error('arcade-runtime: replay needs at least one player');
    this.replay = replay;
  }

  get frame(): number {
    return this._frame;
  }

  get done(): boolean {
    return this._frame >= replayLength(this.replay);
  }

  /** The next step's masks, or `null` once the replay is exhausted. */
  next(): number[] | null {
    if (this.done) return null;
    const { players, inputs } = this.replay;
    const base = this._frame * players;
    this._frame++;
    return inputs.slice(base, base + players);
  }

  seek(frame: number): void {
    this._frame = Math.max(0, Math.min(frame, replayLength(this.replay)));
  }
}

export interface RunReplayOptions<S> {
  /** Starting state; mutated in place if `step` mutates. */
  state: S;
  /** One sim step. Return a new state, or mutate and return nothing. */
  step: (state: S, inputs: number[], frame: number) => S | void;
  replay: Replay;
  /** Hash every Nth step's resulting state (default 1); `0` hashes only the final state. */
  hashEvery?: number;
}

export interface RunReplayResult<S> {
  state: S;
  /** `[frame, hash]` pairs, `frame` being the step count after which the state was hashed. */
  hashes: [number, number][];
}

/**
 * Plays a replay through a step function headlessly, hashing the state as it
 * goes — the core of an input-replay regression test.
 */
export function runReplay<S>(opts: RunReplayOptions<S>): RunReplayResult<S> {
  const { step, replay } = opts;
  const every = opts.hashEvery ?? 1;
  const player = new ReplayPlayer(replay);
  let state = opts.state;
  const hashes: [number, number][] = [];
  let inputs: number[] | null;
  while ((inputs = player.next()) !== null) {
    const frame = player.frame - 1;
    const next = step(state, inputs, frame);
    if (next !== undefined) state = next;
    if (every > 0 && player.frame % every === 0) hashes.push([player.frame, hashState(state)]);
  }
  if (every === 0 || hashes.at(-1)?.[0] !== player.frame) hashes.push([player.frame, hashState(state)]);
  return { state, hashes };
}

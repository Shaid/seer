/** Messages between `createAudioWorkletHost()` and a `defineGeneratorProcessor()` worklet. */

export type HostToWorkletMessage =
  | { type: 'start' }
  /** Silences output and drops queued commands; the generator keeps its state. */
  | { type: 'stop' }
  /** Drops queued commands and calls the generator's `reset()`. */
  | { type: 'reset' }
  /** A command for the generator, timed to sim step `frame`. */
  | { type: 'command'; frame: number; data: unknown }
  /** Untimed, passed straight to the generator's `message()`. */
  | { type: 'message'; data: unknown };

export type WorkletToHostMessage = { type: 'message'; data: unknown };

/** Timing settings the host passes in `processorOptions.runtime`. */
export interface WorkletRuntimeOptions {
  /** Sim step rate in Hz — converts command frame numbers to sample offsets. */
  hz: number;
  /**
   * How many steps of latency to schedule commands behind real time, default
   * `2`. More absorbs more rAF jitter; less responds sooner.
   */
  leadFrames?: number;
}

export interface GeneratorProcessorOptions {
  runtime: WorkletRuntimeOptions;
  /** The host's own `processorOptions`, passed through untouched. */
  user?: unknown;
}

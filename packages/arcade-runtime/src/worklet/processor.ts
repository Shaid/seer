/**
 * Worklet-side base for "render N samples from a generator": a sound
 * driver port supplies a `SampleGenerator`, and the runner splits each
 * 128-sample render quantum at command boundaries so every command takes
 * effect on the exact sample its frame stamp maps to.
 *
 * Nothing here touches the DOM, so a worklet module bundles this plus a chip
 * model (e.g. `@seer-project/arcade/yamaha`) and nothing else.
 */

import type { GeneratorProcessorOptions, HostToWorkletMessage, WorkletToHostMessage } from './protocol.js';
import { CommandScheduler } from './scheduler.js';

export interface SampleGenerator<C = unknown> {
  /**
   * Writes `count` samples into each channel starting at `offset`. The
   * buffers arrive zeroed; fill every channel that should be heard (copy
   * channel 0 into channel 1 for a mono source).
   */
  render(channels: Float32Array[], offset: number, count: number): void;
  /** A frame-timed command from the host, e.g. a sound-latch byte. */
  command?(data: C): void;
  /** An untimed message from the host. */
  message?(data: unknown): void;
  reset?(): void;
}

export interface GeneratorContext {
  sampleRate: number;
  /** The host's `processorOptions`, untouched. */
  options: unknown;
  /** Posts `data` to the host's `onMessage` handler. */
  post(data: unknown): void;
}

/**
 * The message handling and render loop, separate from the
 * `AudioWorkletProcessor` subclass so it runs (and is tested) anywhere.
 */
export class GeneratorRunner<C = unknown> {
  readonly scheduler: CommandScheduler<C>;
  private readonly generator: SampleGenerator<C>;
  private running = false;
  /** Samples rendered (or silenced) so far — the scheduler's clock. */
  private position = 0;

  constructor(generator: SampleGenerator<C>, sampleRate: number, options: GeneratorProcessorOptions) {
    this.generator = generator;
    this.scheduler = new CommandScheduler<C>({
      sampleRate,
      hz: options.runtime.hz,
      leadFrames: options.runtime.leadFrames,
    });
  }

  get playing(): boolean {
    return this.running;
  }

  handle(msg: HostToWorkletMessage): void {
    switch (msg.type) {
      case 'start':
        this.running = true;
        break;
      case 'stop':
        this.running = false;
        this.scheduler.clear();
        break;
      case 'reset':
        this.scheduler.clear();
        this.generator.reset?.();
        break;
      case 'command':
        if (this.running) this.scheduler.enqueue(msg.frame, msg.data as C, this.position);
        break;
      case 'message':
        this.generator.message?.(msg.data);
        break;
    }
  }

  /** Fills `channels` (one render quantum). Returns `true` to keep the processor alive. */
  process(channels: Float32Array[]): boolean {
    const count = channels[0]?.length ?? 0;
    if (!this.running || count === 0) {
      this.position += count;
      return true;
    }
    const start = this.position;
    let offset = 0;
    while (offset < count) {
      while (this.scheduler.nextDue() <= start + offset) {
        const cmd = this.scheduler.shift() as C;
        this.generator.command?.(cmd);
      }
      const end = Math.min(count, this.scheduler.nextDue() - start);
      this.generator.render(channels, offset, end - offset);
      offset = end;
    }
    this.position = start + count;
    return true;
  }
}

// Minimal AudioWorkletGlobalScope typings — lib.dom does not declare them.
interface WorkletProcessorBase {
  readonly port: MessagePort;
}
type WorkletProcessorCtor = new (options?: { processorOptions?: unknown }) => WorkletProcessorBase;
interface WorkletScope {
  AudioWorkletProcessor?: WorkletProcessorCtor;
  registerProcessor?: (name: string, ctor: WorkletProcessorCtor) => void;
  sampleRate?: number;
}

/**
 * Registers an `AudioWorkletProcessor` named `name` that drives the
 * generator `create` returns. Call it at the top level of a worklet module;
 * the host must use the same name.
 */
export function defineGeneratorProcessor<C = unknown>(name: string, create: (ctx: GeneratorContext) => SampleGenerator<C>): void {
  const scope = globalThis as unknown as WorkletScope;
  const Base = scope.AudioWorkletProcessor;
  if (!Base || !scope.registerProcessor) {
    throw new Error('arcade-runtime: defineGeneratorProcessor() must run inside an AudioWorkletGlobalScope');
  }

  class GeneratorProcessor extends Base {
    private readonly runner: GeneratorRunner<C>;

    constructor(options?: { processorOptions?: unknown }) {
      super(options);
      const opts = (options?.processorOptions ?? { runtime: { hz: 60 } }) as GeneratorProcessorOptions;
      const ctx: GeneratorContext = {
        sampleRate: scope.sampleRate ?? 48000,
        options: opts.user,
        post: (data) => this.port.postMessage({ type: 'message', data } satisfies WorkletToHostMessage),
      };
      this.runner = new GeneratorRunner<C>(create(ctx), ctx.sampleRate, opts);
      this.port.onmessage = (e: MessageEvent<HostToWorkletMessage>) => this.runner.handle(e.data);
    }

    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      return this.runner.process(outputs[0] ?? []);
    }
  }

  scope.registerProcessor(name, GeneratorProcessor);
}

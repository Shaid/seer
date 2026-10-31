/**
 * Main-thread side of the audio path: loads a worklet module, creates the
 * node, and forwards frame-stamped commands to it. Game logic only posts
 * sound commands (as the main CPU wrote a sound latch); the sound driver
 * port and chip models run inside the worklet.
 */

import type { GeneratorProcessorOptions, HostToWorkletMessage, WorkletToHostMessage } from './worklet/protocol.js';

export interface AudioWorkletHostOptions {
  /**
   * URL of the worklet module, which must call `defineGeneratorProcessor()`
   * (from `@seer-project/arcade-runtime/worklet`) with `processorName`. With
   * Vite: `import url from './sound.worklet.ts?worker&url'`, which bundles
   * the module's own imports.
   */
  moduleUrl: string | URL;
  processorName: string;
  /** Sim step rate — the worklet converts command frames to sample offsets with it. */
  hz: number;
  /** Steps of scheduling latency, default `2`. */
  leadFrames?: number;
  /** Reuse an existing context; by default one is created (and closed by `dispose()`). */
  context?: AudioContext;
  /** Default `[2]` (one stereo output). */
  outputChannelCount?: number[];
  /** Passed to the generator factory as `ctx.options`. Must be structured-cloneable. */
  processorOptions?: unknown;
  /** 0..1+, default `1`. */
  volume?: number;
}

export interface AudioWorkletHost {
  readonly context: AudioContext;
  readonly node: AudioWorkletNode;
  /** Resumes the context (needs a user gesture the first time) and starts rendering. */
  start(): Promise<void>;
  /** Silences the generator and drops queued commands; `start()` again to resume. */
  stop(): void;
  /** Drops queued commands and calls the generator's `reset()`. */
  reset(): void;
  /** Queues `data` (e.g. a sound-command byte) for sim step `frame`. Ignored while stopped. */
  command(frame: number, data: unknown): void;
  /** Sends an untimed message to the generator. */
  message(data: unknown): void;
  /** Receives whatever the generator `post()`s. Returns an unsubscribe function. */
  onMessage(handler: (data: unknown) => void): () => void;
  volume: number;
  readonly playing: boolean;
  dispose(): Promise<void>;
}

export async function createAudioWorkletHost(opts: AudioWorkletHostOptions): Promise<AudioWorkletHost> {
  const ownsContext = !opts.context;
  const context = opts.context ?? new AudioContext();
  await context.audioWorklet.addModule(String(opts.moduleUrl));

  const processorOptions: GeneratorProcessorOptions = {
    runtime: { hz: opts.hz, leadFrames: opts.leadFrames },
    user: opts.processorOptions,
  };
  const node = new AudioWorkletNode(context, opts.processorName, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: opts.outputChannelCount ?? [2],
    processorOptions,
  });
  const gain = context.createGain();
  gain.gain.value = opts.volume ?? 1;
  node.connect(gain).connect(context.destination);

  const handlers = new Set<(data: unknown) => void>();
  node.port.onmessage = (e: MessageEvent<WorkletToHostMessage>) => {
    if (e.data?.type === 'message') for (const h of handlers) h(e.data.data);
  };

  const post = (msg: HostToWorkletMessage): void => node.port.postMessage(msg);
  let playing = false;
  let disposed = false;

  return {
    context,
    node,
    async start() {
      if (context.state === 'suspended') await context.resume();
      post({ type: 'start' });
      playing = true;
    },
    stop() {
      post({ type: 'stop' });
      playing = false;
    },
    reset() {
      post({ type: 'reset' });
    },
    command(frame, data) {
      if (playing) post({ type: 'command', frame, data });
    },
    message(data) {
      post({ type: 'message', data });
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    get volume() {
      return gain.gain.value;
    },
    set volume(v: number) {
      gain.gain.value = v;
    },
    get playing() {
      return playing;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (playing) post({ type: 'stop' });
      playing = false;
      handlers.clear();
      node.port.onmessage = null;
      node.disconnect();
      gain.disconnect();
      if (ownsContext) await context.close();
    },
  };
}

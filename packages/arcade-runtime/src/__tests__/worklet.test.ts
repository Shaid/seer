import { describe, expect, it } from 'vitest';
import { CommandScheduler, GeneratorRunner, defineGeneratorProcessor, type SampleGenerator } from '../worklet/index.js';

describe('CommandScheduler', () => {
  it('anchors the first command lead frames ahead and keeps relative spacing', () => {
    const s = new CommandScheduler<string>({ sampleRate: 48000, hz: 60, leadFrames: 2 });
    expect(s.samplesPerFrame).toBe(800);
    s.enqueue(100, 'a', 0);
    s.enqueue(103, 'b', 10);
    expect(s.nextDue()).toBe(1600);
    expect(s.shift()).toBe('a');
    expect(s.nextDue()).toBe(1600 + 3 * 800);
    expect(s.shift()).toBe('b');
    expect(s.nextDue()).toBe(Infinity);
  });

  it('re-anchors when a command would land in the past or too far ahead', () => {
    const s = new CommandScheduler<string>({ sampleRate: 48000, hz: 60, leadFrames: 2 });
    s.enqueue(0, 'a', 0);
    s.shift();
    // The sim paused for a second: frame 1 is long overdue.
    s.enqueue(1, 'late', 48000);
    expect(s.nextDue()).toBe(48000 + 1600);
    s.shift();
    // Fast-forward: frame 500 is far beyond the max lead.
    s.enqueue(500, 'ahead', 48000);
    expect(s.nextDue()).toBe(48000 + 1600);
  });

  it('never reorders commands', () => {
    const s = new CommandScheduler<number>({ sampleRate: 48000, hz: 60 });
    s.enqueue(10, 1, 0);
    s.enqueue(9, 2, 0);
    expect(s.shift()).toBe(1);
    const second = s.nextDue();
    expect(s.shift()).toBe(2);
    expect(second).toBeGreaterThanOrEqual(1600);
  });

  it('uses a fractional samples-per-frame for board rates', () => {
    const s = new CommandScheduler({ sampleRate: 44100, hz: 59.637 });
    expect(s.samplesPerFrame).toBeCloseTo(739.47, 2);
  });
});

/** Emits a constant level set by the last command; logs each render span. */
function levelGenerator() {
  const spans: [number, number, number][] = [];
  let level = 0;
  const gen: SampleGenerator<number> & { spans: typeof spans; resets: number } = {
    spans,
    resets: 0,
    render(channels, offset, count) {
      spans.push([offset, count, level]);
      for (const ch of channels) ch.fill(level, offset, offset + count);
    },
    command(v) {
      level = v;
    },
    reset() {
      gen.resets++;
      level = 0;
    },
  };
  return gen;
}

describe('GeneratorRunner', () => {
  const opts = { runtime: { hz: 375, leadFrames: 1 } }; // 128 samples per frame at 48 kHz

  it('is silent until started', () => {
    const gen = levelGenerator();
    const r = new GeneratorRunner(gen, 48000, opts);
    const out = [new Float32Array(128)];
    r.process(out);
    expect(gen.spans).toEqual([]);
    r.handle({ type: 'command', frame: 0, data: 1 });
    expect(r.scheduler.pending).toBe(0);
  });

  it('splits a render quantum exactly at the command sample', () => {
    const gen = levelGenerator();
    const r = new GeneratorRunner(gen, 48000, { runtime: { hz: 750, leadFrames: 1 } }); // 64 samples/frame
    r.handle({ type: 'start' });
    r.handle({ type: 'command', frame: 0, data: 0.5 }); // due at 64
    const out = [new Float32Array(128), new Float32Array(128)];
    r.process(out);
    expect(gen.spans).toEqual([
      [0, 64, 0],
      [64, 64, 0.5],
    ]);
    expect(out[1]![63]).toBe(0);
    expect(out[1]![64]).toBe(0.5);
  });

  it('applies commands due at the same sample in order, across quanta', () => {
    const gen = levelGenerator();
    const r = new GeneratorRunner(gen, 48000, opts);
    r.handle({ type: 'start' });
    r.handle({ type: 'command', frame: 10, data: 1 }); // anchors at 128
    r.handle({ type: 'command', frame: 10, data: 2 });
    r.handle({ type: 'command', frame: 11, data: 3 }); // 256
    const out = [new Float32Array(128)];
    r.process(out);
    expect(out[0]![127]).toBe(0);
    r.process(out);
    expect(out[0]![0]).toBe(2);
    r.process(out);
    expect(out[0]![0]).toBe(3);
  });

  it('stop drops queued commands; reset calls the generator', () => {
    const gen = levelGenerator();
    const r = new GeneratorRunner(gen, 48000, opts);
    r.handle({ type: 'start' });
    r.handle({ type: 'command', frame: 0, data: 1 });
    r.handle({ type: 'stop' });
    expect(r.scheduler.pending).toBe(0);
    expect(r.playing).toBe(false);
    r.handle({ type: 'reset' });
    expect(gen.resets).toBe(1);
  });

  it('forwards untimed messages', () => {
    const got: unknown[] = [];
    const r = new GeneratorRunner({ render() {}, message: (d) => got.push(d) }, 48000, opts);
    r.handle({ type: 'message', data: { volume: 3 } });
    expect(got).toEqual([{ volume: 3 }]);
  });
});

describe('defineGeneratorProcessor', () => {
  it('refuses to run outside an AudioWorkletGlobalScope', () => {
    expect(() => defineGeneratorProcessor('x', () => ({ render() {} }))).toThrow(/AudioWorkletGlobalScope/);
  });

  it('registers a processor that wires the port to the runner', () => {
    const g = globalThis as Record<string, unknown>;
    const registered: Record<string, new (o?: unknown) => unknown> = {};
    class FakeProcessor {
      port = { postMessage: (m: unknown) => posted.push(m), onmessage: null as ((e: { data: unknown }) => void) | null };
    }
    const posted: unknown[] = [];
    g.AudioWorkletProcessor = FakeProcessor;
    g.registerProcessor = (name: string, ctor: new (o?: unknown) => unknown) => {
      registered[name] = ctor;
    };
    g.sampleRate = 48000;
    try {
      let seenOptions: unknown;
      defineGeneratorProcessor('test-gen', (ctx) => {
        seenOptions = ctx.options;
        ctx.post('ready');
        return levelGenerator();
      });
      const Ctor = registered['test-gen']!;
      const proc = new Ctor({ processorOptions: { runtime: { hz: 750, leadFrames: 1 }, user: { song: 3 } } }) as FakeProcessor & {
        process(i: Float32Array[][], o: Float32Array[][]): boolean;
      };
      expect(seenOptions).toEqual({ song: 3 });
      expect(posted).toEqual([{ type: 'message', data: 'ready' }]);
      proc.port.onmessage!({ data: { type: 'start' } });
      proc.port.onmessage!({ data: { type: 'command', frame: 0, data: 0.25 } });
      const out = [new Float32Array(128)];
      expect(proc.process([], [out])).toBe(true);
      expect(out[0]![64]).toBe(0.25);
    } finally {
      delete g.AudioWorkletProcessor;
      delete g.registerProcessor;
      delete g.sampleRate;
    }
  });
});

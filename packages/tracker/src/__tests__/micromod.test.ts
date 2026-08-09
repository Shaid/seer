import { describe, it, expect } from 'vitest';
import { Module, Micromod } from '../micromod.js';
import { buildMod, buildAudibleMod } from './mod-fixture.js';

const RATE = 44100;

function render(player: Micromod, frames: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  player.getAudio(left, right, frames);
  return { left, right };
}

const peak = (buf: Float32Array): number => buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/**
 * `Micromod` is the replay/mixing half of the bundled port. It touches no Web
 * Audio API at all — it just fills two Float32Arrays — so the actual DSP can
 * be exercised directly in Node rather than only through a live AudioWorklet.
 */
describe('Micromod', () => {
  it('renders silence for a module with no instruments', () => {
    const player = new Micromod(new Module(buildMod()), RATE);
    const { left, right } = render(player, 4096);
    expect(peak(left)).toBe(0);
    expect(peak(right)).toBe(0);
  });

  it('renders audio for a module with a triggered note', () => {
    const player = new Micromod(new Module(buildAudibleMod()), RATE);
    const { left } = render(player, 8192);
    expect(peak(left)).toBeGreaterThan(0.01);
  });

  it('fills exactly the requested number of frames, across repeated calls', () => {
    const player = new Micromod(new Module(buildAudibleMod()), RATE);
    // Deliberately not a tick multiple, so the mix buffer straddles calls.
    const first = render(player, 1000);
    const second = render(player, 1000);
    expect(first.left.length).toBe(1000);
    expect(second.left.length).toBe(1000);
    // The stream advances rather than restarting each call.
    expect(Array.from(second.left)).not.toEqual(Array.from(first.left));
  });

  it('is deterministic — same module, same output', () => {
    const mod = new Module(buildAudibleMod());
    const a = render(new Micromod(mod, RATE), 4096);
    const b = render(new Micromod(mod, RATE), 4096);
    expect(Array.from(a.left)).toEqual(Array.from(b.left));
    expect(Array.from(a.right)).toEqual(Array.from(b.right));
  });

  it('pans channels apart rather than emitting identical stereo', () => {
    // Channel 0 is panned hard-ish left (Amiga-style separation), so a single
    // playing channel must not produce an identical pair of buffers.
    const player = new Micromod(new Module(buildAudibleMod()), RATE);
    const { left, right } = render(player, 8192);
    expect(peak(left)).toBeGreaterThan(0.01);
    expect(Array.from(left)).not.toEqual(Array.from(right));
  });

  it('setSequencePos resets playback state and re-renders from that position', () => {
    const mod = new Module(buildAudibleMod());
    const player = new Micromod(mod, RATE);
    const first = render(player, 2048);
    render(player, 2048); // advance somewhere else
    player.setSequencePos(0);
    const replayed = render(player, 2048);
    expect(Array.from(replayed.left)).toEqual(Array.from(first.left));
  });

  it('setSequencePos wraps an out-of-range position to the start', () => {
    const player = new Micromod(new Module(buildAudibleMod()), RATE);
    expect(() => player.setSequencePos(99)).not.toThrow();
    expect(player.finished).toBe(false);
  });

  it('rejects a sampling rate outside the supported range', () => {
    const player = new Micromod(new Module(buildMod()), RATE);
    expect(() => player.setSamplingRate(7999)).toThrow('Unsupported sampling rate');
    expect(() => player.setSamplingRate(128001)).toThrow('Unsupported sampling rate');
    expect(() => player.setSamplingRate(48000)).not.toThrow();
  });

  it('reports a positive song duration and terminates', () => {
    // Two sequence entries so the song wraps backwards and marks itself
    // finished, rather than looping forever.
    const mod = new Module(buildAudibleMod({ sequence: [0, 1], sequenceLength: 2 }));
    const player = new Micromod(mod, RATE);
    const duration = player.calculateSongDuration();
    expect(duration).toBeGreaterThan(0);
    // calculateSongDuration rewinds when it's done.
    expect(player.finished).toBe(false);
  }, 20_000);

  it('starts un-finished and flags finished once the song wraps', () => {
    const mod = new Module(buildAudibleMod({ sequence: [0, 1], sequenceLength: 2 }));
    const player = new Micromod(mod, RATE);
    expect(player.finished).toBe(false);

    const total = player.calculateSongDuration();
    render(player, total + RATE); // run past the end
    expect(player.finished).toBe(true);
  }, 20_000);

  it('accepts the interpolation toggle and still renders', () => {
    const player = new Micromod(new Module(buildAudibleMod()), RATE);
    player.setInterpolation(true);
    expect(peak(render(player, 4096).left)).toBeGreaterThan(0);
  });

  it('handles a module with more than four channels', () => {
    const mod = new Module(
      buildAudibleMod({ tag: '6CHN', notes: [{ index: 0, period: 856, instrument: 1 }] }),
    );
    expect(mod.numChannels).toBe(6);
    expect(peak(render(new Micromod(mod, RATE), 4096).left)).toBeGreaterThan(0);
  });
});

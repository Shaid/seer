import { describe, it, expect } from 'vitest';
import { renderToStereoBuffers } from '../render-driver.ts';
import type { BlockRenderer } from '../render-driver.ts';

/** A fake renderer producing an ascending-index ramp for `totalSamples`, then silence, finishing once `totalSamples + silentTail` samples have been produced. */
function makeRampRenderer(totalSamples: number, silentTail: number): BlockRenderer {
  let produced = 0;
  const grandTotal = totalSamples + silentTail;
  return {
    renderBlock(n: number): [Float32Array, Float32Array] {
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const idx = produced + i;
        if (idx < totalSamples) {
          l[i] = (idx + 1) / totalSamples; // 1/N .. 1, always > silenceThreshold
          r[i] = l[i];
        }
      }
      produced += n;
      return [l, r];
    },
    get finished() {
      return produced >= grandTotal;
    },
  };
}

function makeSilentRenderer(totalCalls: number): BlockRenderer {
  let calls = 0;
  return {
    renderBlock(n: number): [Float32Array, Float32Array] {
      calls++;
      return [new Float32Array(n), new Float32Array(n)];
    },
    get finished() {
      return calls >= totalCalls;
    },
  };
}

describe('renderToStereoBuffers', () => {
  it('concatenates chunks in order, stopping at the first finished block', () => {
    const renderer = makeRampRenderer(500, 100);
    // grandTotal=600; 128-sample blocks: 128,256,384,512(not finished, 512<600),640(finished, 640>=600) -> 5 blocks = 640.
    // tailSeconds huge so the trim window covers everything already rendered (no additional truncation).
    const [left, right] = renderToStereoBuffers(renderer, { sampleRate: 1000, blockSize: 128, tailSeconds: 10 });
    expect(left.length).toBe(right.length);
    expect(left.length).toBe(640);
    // first/last-of-ramp samples match the renderer's own formula, confirming chunks landed in order.
    expect(left[0]).toBeCloseTo(1 / 500, 6);
    expect(left[499]).toBeCloseTo(1.0, 6);
  });

  it('trims to exactly lastNonZero + tailSeconds*sampleRate past the last non-silent sample', () => {
    const totalSamples = 300;
    const renderer = makeRampRenderer(totalSamples, 1000); // long silent tail so the untrimmed length would be much bigger
    const sampleRate = 1000;
    const tailSeconds = 0.05; // 50 samples
    const [left] = renderToStereoBuffers(renderer, { sampleRate, blockSize: 64, tailSeconds, silenceThreshold: 1e-4 });
    // lastNonZero is index totalSamples-1 (299), trim length = 299 + 50 = 349, clamped to totalLen.
    expect(left.length).toBe(300 - 1 + 50);
  });

  it('an all-silent renderer is returned untrimmed, not zero-length', () => {
    const renderer = makeSilentRenderer(3);
    const [left, right] = renderToStereoBuffers(renderer, { sampleRate: 1000, blockSize: 100 });
    expect(left.length).toBe(300);
    expect(right.length).toBe(300);
    expect(Array.from(left).every((v) => v === 0)).toBe(true);
  });

  it('stops at maxSeconds even if the renderer never reports finished', () => {
    const neverFinishes: BlockRenderer = {
      renderBlock: (n) => [new Float32Array(n), new Float32Array(n)],
      finished: false,
    };
    const [left] = renderToStereoBuffers(neverFinishes, { sampleRate: 1000, blockSize: 100, maxSeconds: 0.5 });
    // maxSamples = 500, loop keeps rendering 100-sample blocks until total >= 500 -> exactly 500 (silent, untrimmed)
    expect(left.length).toBe(500);
  });
});

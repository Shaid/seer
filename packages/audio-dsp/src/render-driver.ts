/**
 * Generic offline batch-render driver: pull fixed-size stereo blocks from a
 * source until it reports itself finished (or a hard time cap is hit), then
 * concatenate and trim trailing near-silence.
 *
 * Extracted from `@seer-project/smus`'s `SmusEngine.renderAll()` — this is
 * the block-loop/concat/trim *shape*, not anything Sonix- or SMUS-specific;
 * any offline synthesis engine that can hand back fixed-size stereo chunks
 * on demand fits `BlockRenderer` as-is.
 */

/** Anything that can render itself in fixed-size stereo chunks and report when it has nothing left to produce. */
export interface BlockRenderer {
  /** Render exactly `n` samples of stereo audio (left, right), advancing internal state. */
  renderBlock(n: number): [Float32Array, Float32Array];
  /** True once the source has no more real audio to produce (all voices/tracks idle). */
  readonly finished: boolean;
}

export interface RenderToStereoBuffersOptions {
  /** Sample rate the renderer is producing at — used only to convert `tailSeconds` to a sample count. */
  sampleRate: number;
  /** Hard cap on total rendered duration, in seconds, in case `finished` never goes true. Default 300. */
  maxSeconds?: number;
  /** Samples requested per `renderBlock` call. Default 2048. */
  blockSize?: number;
  /** A sample's absolute value at or below this is treated as silence when scanning for the trim point. Default 1e-4. */
  silenceThreshold?: number;
  /** Extra time kept after the last non-silent sample, so a release tail isn't clipped. Default 0.25s. */
  tailSeconds?: number;
}

/**
 * Render a `BlockRenderer` to completion and return trimmed stereo buffers.
 *
 * Renders `blockSize`-sample chunks until `renderer.finished` is true or
 * `maxSeconds` of audio has been produced, concatenates every chunk, then
 * scans backward for the last sample (either channel) whose magnitude
 * exceeds `silenceThreshold` and trims to `tailSeconds` past it — matching
 * `SmusEngine.renderAll()`'s exact trim behaviour (a totally silent render
 * is returned untrimmed, not zero-length).
 */
export function renderToStereoBuffers(
  renderer: BlockRenderer,
  opts: RenderToStereoBuffersOptions,
): [Float32Array, Float32Array] {
  const blockSize = opts.blockSize ?? 2048;
  const maxSeconds = opts.maxSeconds ?? 300;
  const silenceThreshold = opts.silenceThreshold ?? 1e-4;
  const tailSeconds = opts.tailSeconds ?? 0.25;

  const maxSamples = Math.floor(maxSeconds * opts.sampleRate);
  const chunks: Array<[Float32Array, Float32Array]> = [];
  let total = 0;
  while (total < maxSamples) {
    const [l, r] = renderer.renderBlock(blockSize);
    chunks.push([l, r]);
    total += blockSize;
    if (renderer.finished) break;
  }

  const totalLen = chunks.reduce((s, [l]) => s + l.length, 0);
  const left = new Float32Array(totalLen);
  const right = new Float32Array(totalLen);
  let off = 0;
  for (const [l, r] of chunks) {
    left.set(l, off);
    right.set(r, off);
    off += l.length;
  }

  let lastNonZero = -1;
  for (let i = totalLen - 1; i >= 0; i--) {
    if (Math.abs(left[i]) > silenceThreshold || Math.abs(right[i]) > silenceThreshold) {
      lastNonZero = i;
      break;
    }
  }
  if (lastNonZero >= 0) {
    const trimLen = Math.min(totalLen, lastNonZero + Math.floor(opts.sampleRate * tailSeconds));
    return [left.subarray(0, trimLen), right.subarray(0, trimLen)];
  }
  return [left, right];
}

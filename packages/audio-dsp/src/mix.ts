/**
 * Generic voice mixdown helpers: accumulate a mono voice buffer into a
 * stereo output at independent left/right gains, and apply a clamped
 * master-volume pass.
 *
 * Extracted from `@seer-project/smus`'s `SmusEngine.renderBlock()`, which
 * used a hard binary per-channel pan (`CHANNEL_PAN`, each voice fully left
 * or fully right) — `mixVoiceStereo`'s independent `gainL`/`gainR`
 * parameters generalize that (pass `1, 0` or `0, 1` to reproduce it exactly)
 * without forcing every future consumer into a binary-pan model.
 */

/** Add `count` samples of `mono` (starting at `monoOffset`) into `outL`/`outR` (starting at `outOffset`) at independent gains. Accumulates — does not overwrite — so multiple voices can be summed into the same buffer. */
export function mixVoiceStereo(
  outL: Float32Array,
  outR: Float32Array,
  mono: Float32Array,
  gainL: number,
  gainR: number,
  outOffset: number,
  count: number,
  monoOffset = 0,
): void {
  if (gainL !== 0) {
    for (let i = 0; i < count; i++) outL[outOffset + i] += mono[monoOffset + i] * gainL;
  }
  if (gainR !== 0) {
    for (let i = 0; i < count; i++) outR[outOffset + i] += mono[monoOffset + i] * gainR;
  }
}

/** Scale a full stereo buffer by `gain` and hard-clamp to [-1, 1], in place. */
export function applyMasterGain(outL: Float32Array, outR: Float32Array, gain: number): void {
  for (let i = 0; i < outL.length; i++) {
    outL[i] = Math.max(-1, Math.min(1, outL[i] * gain));
  }
  for (let i = 0; i < outR.length; i++) {
    outR[i] = Math.max(-1, Math.min(1, outR[i] * gain));
  }
}

/**
 * @seer-project/audio-dsp — format-agnostic real-time-audio primitives
 * shared by @seer-project's synthesis engines.
 *
 * Zero runtime dependencies. Contains no synthesis (no oscillators, no
 * waveform generation) and no format parsing — only the block-render
 * driver loop, voice mixdown, and fractional-position (optionally looped)
 * resampling that a from-scratch offline synthesis engine needs, extracted
 * because they were duplicated (or about to be) across more than one real
 * consumer. See each module's own doc comment for what it is and, just as
 * importantly, what deliberately stayed out of this package.
 */

export {
  renderToStereoBuffers,
  type BlockRenderer,
  type RenderToStereoBuffersOptions,
} from './render-driver.js';
export { mixVoiceStereo, applyMasterGain } from './mix.js';
export {
  resampleLooped,
  GAUSSIAN_TABLE,
  type InterpolationKernel,
  type ResampleResult,
} from './resample.js';

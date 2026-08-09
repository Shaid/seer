/**
 * @seer-project/smus — SMUS (Simple Musical Score) interpreter and Sonix audio engine.
 *
 * A working reference implementation of the EA IFF 85 SMUS format and
 * the Sonix synthesis/sample playback engine used by Melbourne House on
 * Amiga, DOS, and Apple IIGS.
 *
 * Includes:
 *   - SMUS parser (SHDR/NAME/INS1/TRAK chunk decoding)
 *   - SampledSound .instr parser (external, embedded/synth, 8SVX variants)
 *   - .ss multi-octave sample file parser
 *   - Sonix filter bank generator and voice allocator
 *   - SmusEngine: renders SMUS scores to stereo PCM via WebAudio or offline
 */

// SMUS parser
export {
  parseSMUS,
  durationName,
  eventDuration,
  tempoToBPM,
  SID_FirstNote,
  SID_LastNote,
  SID_Rest,
  SID_Instrument,
  SID_TimeSig,
  SID_KeySig,
  SID_Dynamic,
  SID_MIDI_Chnl,
  SID_MIDI_Preset,
  SID_Clef,
  SID_Tempo,
  type SScoreHeader,
  type SEvent,
  type SNote,
  type STimeSigEvent,
  type SInstrumentRef,
  type SEventStream,
  type SSong,
} from './smus.js';

// SampledSound .instr / .ss parser
export {
  parseInstr,
  parseSs,
  parseSynthModulation,
  synthesizeWaveform,
  unsignedToSigned,
  periodToSampleRate,
  instrSampleRate,
  type InstrCommon,
  type ExternalParams,
  type InstrExternal,
  type SynthData,
  type SynthParams,
  type InstrEmbedded,
  type Instr8SVX,
  type Instr,
  type SynthModulation,
  type SsFile,
} from './sampled-sound.js';

// Sonix engine + instrument converters
export {
  SmusEngine,
  parseSmusScore,
  defaultInstrument,
  instrumentFromSynth,
  instrumentFromSampled,
  instrumentFrom8svx,
  sonixOneFilter,
  sonixRateUnits,
  sampleOctaveForMidi,
  SID_REST,
  SID_INSTRUMENT,
  SID_DYNAMIC,
  SID_TEMPO,
  type SmusScore,
  type Instrument,
} from './smus-engine.js';

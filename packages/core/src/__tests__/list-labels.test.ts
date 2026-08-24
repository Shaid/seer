import { describe, it, expect } from 'vitest';
import { computeCommonAffixes, stripCommonAffixes } from '../list-labels.js';

describe('computeCommonAffixes', () => {
  it('finds a shared prefix and suffix, cut on `_` boundaries', () => {
    const names = ['nier_audio_movie_synth_0100_a0010_wav', 'nier_audio_movie_synth_0200_a0050_wav', 'nier_audio_movie_synth_0200_a0060_wav'];
    expect(computeCommonAffixes(names)).toEqual({ prefix: 'nier_audio_movie_synth_', suffix: '_wav' });
  });

  it('never cuts a shared token in half', () => {
    // Raw common prefix would be "ab_cdef" (7 chars) — must trim back to the last `_` at "ab_".
    const names = ['ab_cdef_one', 'ab_cdefg_two'];
    const { prefix } = computeCommonAffixes(names);
    expect(prefix).toBe('ab_');
  });

  it('returns empty when fewer than two names are given', () => {
    expect(computeCommonAffixes([])).toEqual({ prefix: '', suffix: '' });
    expect(computeCommonAffixes(['only_one'])).toEqual({ prefix: '', suffix: '' });
  });

  it('returns empty when there is no `_`-bounded overlap at all', () => {
    expect(computeCommonAffixes(['apple', 'banana', 'cherry'])).toEqual({ prefix: '', suffix: '' });
  });

  it('backs off entirely rather than let the overlap consume a whole name', () => {
    // "a_b" is a prefix of "a_b_c" but also equal to a full other name.
    expect(computeCommonAffixes(['a_b', 'a_b_c'])).toEqual({ prefix: '', suffix: '' });
  });

  it('does not require the suffix to be present on every name (partial-overlap tail differences)', () => {
    // A trailing disambiguating suffix on one entry (e.g. a collision counter) breaks the common suffix — expected, not a bug.
    const names = ['nier_audio_voice_synth_a_wav', 'nier_audio_voice_synth_b_wav', 'nier_audio_voice_synth_c_wav_1'];
    const { suffix } = computeCommonAffixes(names);
    expect(suffix).toBe('');
  });
});

describe('stripCommonAffixes', () => {
  it('strips both a prefix and a suffix', () => {
    expect(stripCommonAffixes('nier_audio_movie_synth_0100_a0010_wav', 'nier_audio_movie_synth_', '_wav')).toBe('0100_a0010');
  });

  it('is a no-op when prefix/suffix are empty', () => {
    expect(stripCommonAffixes('anything', '', '')).toBe('anything');
  });

  it('falls back to the full name rather than return an empty string', () => {
    expect(stripCommonAffixes('pre_suf', 'pre_suf', '')).toBe('pre_suf');
  });
});

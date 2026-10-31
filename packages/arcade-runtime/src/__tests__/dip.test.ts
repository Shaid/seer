import { describe, expect, it } from 'vitest';
import { defineDipSwitches, type DipSettings } from '../dip.js';

// Shaped like a real board's DSW B: lives in bits 0-1, difficulty in 2-4, a flip bit.
const schema = {
  lives: {
    label: 'Lives',
    default: 3,
    bank: 1,
    mask: 0x03,
    options: [
      { value: 2, label: '2', bits: 0x02 },
      { value: 3, label: '3', bits: 0x03 },
      { value: 5, label: '5', bits: 0x01 },
      { value: 7, label: '7', bits: 0x00 },
    ],
  },
  difficulty: {
    label: 'Difficulty',
    default: 'normal',
    bank: 1,
    mask: 0x1c,
    options: [
      { value: 'easy', label: 'Easy', bits: 0x1c },
      { value: 'normal', label: 'Normal', bits: 0x14 },
      { value: 'hard', label: 'Hard', bits: 0x0c },
    ],
  },
  flip: {
    label: 'Flip Screen',
    default: false,
    bank: 0,
    mask: 0x40,
    options: [
      { value: false, label: 'Off', bits: 0x40 },
      { value: true, label: 'On', bits: 0x00 },
    ],
  },
  region: { label: 'Region', default: 'world', options: [{ value: 'world', label: 'World' }, { value: 'japan', label: 'Japan' }] },
} as const;

describe('defineDipSwitches', () => {
  const dips = defineDipSwitches(schema);

  it('produces typed defaults', () => {
    const d: DipSettings<typeof schema> = dips.defaults();
    expect(d).toEqual({ lives: 3, difficulty: 'normal', flip: false, region: 'world' });
  });

  it('parse keeps valid values and resets invalid or missing ones', () => {
    expect(dips.parse({ lives: 5, difficulty: 'impossible', bogus: 1 })).toEqual({
      lives: 5,
      difficulty: 'normal',
      flip: false,
      region: 'world',
    });
    expect(dips.parse('garbage')).toEqual(dips.defaults());
    const s = { ...dips.defaults(), region: 'japan' as const };
    expect(dips.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('packs and unpacks raw bank bytes', () => {
    const s = { ...dips.defaults(), lives: 7 as const, difficulty: 'hard' as const, flip: true };
    const banks = dips.toBanks(s);
    expect(banks).toEqual([0xff & ~0x40, (0xff & ~0x1f) | 0x0c]);
    expect(dips.fromBanks(banks)).toEqual(s);
    expect(dips.toBanks(dips.defaults(), 3, 0x00)).toEqual([0x40, 0x17, 0x00]);
  });

  it('option() resolves the chosen option record', () => {
    expect(dips.option({ ...dips.defaults(), lives: 5 }, 'lives').bits).toBe(0x01);
  });

  it('rejects a default that is not an option', () => {
    expect(() => defineDipSwitches({ x: { label: 'X', default: 1, options: [{ value: 2, label: '2' }] } })).toThrow();
  });
});

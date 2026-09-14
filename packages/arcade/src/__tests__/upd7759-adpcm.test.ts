import { describe, it, expect } from 'vitest';
import { Upd7759AdpcmState, decodeUpd7759Slave, UPD7759_SLAVE_PREAMBLE_BYTES, UPD7759_DEFAULT_GAIN } from '../sega/upd7759-adpcm.js';

describe('Upd7759AdpcmState.clock (hand-derived from MAME upd775x_step/upd775x_state_table)', () => {
  it('matches values hand-computed from the step/state tables', () => {
    const s = new Upd7759AdpcmState();
    // state=0, nibble=7 -> STEP[0][7]=10, STATE_TABLE[7]=3
    expect(s.clock(7)).toBe(10);
    expect(s.adpcmState).toBe(3);
    // state=3, nibble=15 -> STEP[3][15]=-19, STATE_TABLE[15]=3
    expect(s.clock(15)).toBe(10 - 19);
    expect(s.adpcmState).toBe(6);
  });

  it('clamps adpcmState to [0,15] and wraps sample as int16', () => {
    const s = new Upd7759AdpcmState();
    for (let i = 0; i < 100; i++) s.clock(0xf); // nibble 15: STATE_TABLE[15]=+3 each time
    expect(s.adpcmState).toBeLessThanOrEqual(15);
    for (let i = 0; i < 100; i++) s.clock(0x0); // nibble 0: STATE_TABLE[0]=-1 each time
    expect(s.adpcmState).toBeGreaterThanOrEqual(0);
  });
});

describe('decodeUpd7759Slave', () => {
  it('skips the 5-byte slave-mode preamble and decodes an all-zero-delta nibble block to silence, terminating on 0x00', () => {
    // FF 00 00 00 00 <header 0x81: kind=n-nibbles, rate=(1&0x3f)+1=2> <count=1 -> 2 nibbles> <data 0x08: nibbles 0,8, both zero-delta from state 0> <0x00 end>
    const rom = new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x00, 0x81, 0x01, 0x08, 0x00]);
    expect(UPD7759_SLAVE_PREAMBLE_BYTES).toBe(5);
    const { pcm, endOffset, terminatedCleanly } = decodeUpd7759Slave(rom, 0, UPD7759_DEFAULT_GAIN);
    expect(terminatedCleanly).toBe(true);
    expect(endOffset).toBe(9); // one past the terminating 0x00
    // 2 nibbles * (rate*4=8 ticks each) + 1 silence block * (1024 * duration=1) ticks
    expect(pcm.length).toBe(2 * 8 + 1024);
    expect(Array.from(pcm)).toEqual(new Array(pcm.length).fill(0));
  });

  it('decodes nonzero nibble deltas with the confirmed gain, holding each value for rate*4 ticks', () => {
    // FF 00 00 00 00 <header 0x80: kind=n-nibbles, rate=(0&0x3f)+1=1 -> 4 ticks/nibble> <count=1 -> 2 nibbles> <data 0x7f: nibbles 7,15> <0x00 end>
    const rom = new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x00, 0x80, 0x01, 0x7f, 0x00]);
    const { pcm, endOffset, terminatedCleanly } = decodeUpd7759Slave(rom, 0, UPD7759_DEFAULT_GAIN);
    expect(terminatedCleanly).toBe(true);
    expect(endOffset).toBe(9);
    const nib0 = 10 * UPD7759_DEFAULT_GAIN; // STEP[0][7]=10
    const nib1 = (10 - 19) * UPD7759_DEFAULT_GAIN; // STEP[3][15]=-19
    const expected = [...new Array(4).fill(nib0), ...new Array(4).fill(nib1), ...new Array(1024).fill(0)];
    expect(Array.from(pcm)).toEqual(expected);
  });

  it('does not run past the caller-provided maxBytes if no terminator is ever found', () => {
    const rom = new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x00, 0x41, 0xff]); // 0x41 = 256-nibble block, but stream is far too short
    const { terminatedCleanly } = decodeUpd7759Slave(rom, 0, UPD7759_DEFAULT_GAIN, 32);
    expect(terminatedCleanly).toBe(false);
  });
});

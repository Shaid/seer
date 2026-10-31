import { describe, expect, it } from 'vitest';
import { assertPlainData, hashState, hashStateHex, restoreState, snapshotState } from '../state.js';
import { RingBuffer } from '../ring-buffer.js';
import { InputRecorder, ReplayPlayer, replayLength, runReplay } from '../replay.js';

function makeState() {
  return {
    frame: 0,
    rng: 0x1234,
    tileRam: new Uint8Array(16),
    palette: new Uint16Array([0x0f00, 0x00f0]),
    player: { x: 10, y: 20, mode: 'walk', flags: [true, false] },
    objects: [{ id: 1, hp: 3 }],
  };
}

describe('snapshotState / restoreState', () => {
  it('snapshots are independent deep copies', () => {
    const s = makeState();
    const snap = snapshotState(s);
    s.tileRam[0] = 99;
    s.player.x = 0;
    expect(snap.tileRam[0]).toBe(0);
    expect(snap.player.x).toBe(10);
    expect(snap.tileRam).toBeInstanceOf(Uint8Array);
  });

  it('restores in place, keeping typed-array identity', () => {
    const s = makeState();
    const tileRam = s.tileRam;
    const player = s.player;
    const snap = snapshotState(s);
    s.tileRam.fill(7);
    s.player.x = 99;
    s.objects.push({ id: 2, hp: 1 });
    (s as Record<string, unknown>).extra = 1;
    restoreState(s, snap);
    expect(s.tileRam).toBe(tileRam);
    expect(s.player).toBe(player);
    expect(hashState(s)).toBe(hashState(snap));
    expect('extra' in s).toBe(false);
    expect(s.objects).toHaveLength(1);
    // The restored state must not alias the snapshot.
    s.objects[0]!.hp = 0;
    expect(snap.objects[0]!.hp).toBe(3);
  });

  it('replaces a typed array whose length changed', () => {
    const s = makeState();
    const snap = snapshotState(s);
    s.tileRam = new Uint8Array(4);
    restoreState(s, snap);
    expect(s.tileRam.length).toBe(16);
    expect(s.tileRam).not.toBe(snap.tileRam);
  });
});

describe('assertPlainData', () => {
  it('accepts plain data', () => {
    expect(() => assertPlainData(makeState())).not.toThrow();
  });

  it('names the offending path', () => {
    expect(() => assertPlainData({ a: { b: new Map() } })).toThrow(/state\.a\.b is a Map/);
    expect(() => assertPlainData({ f: () => 1 })).toThrow(/state\.f is a function/);
    const shared = { x: 1 };
    expect(() => assertPlainData({ a: shared, b: shared })).toThrow(/repeated or cyclic/);
  });
});

describe('hashState', () => {
  it('is stable and ignores key order', () => {
    expect(hashState({ a: 1, b: [2, 3] })).toBe(hashState({ b: [2, 3], a: 1 }));
    expect(hashStateHex({ a: 1 })).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is sensitive to values, structure and typed-array type', () => {
    const base = hashState(makeState());
    const s = makeState();
    s.tileRam[15] = 1;
    expect(hashState(s)).not.toBe(base);
    expect(hashState([1])).not.toBe(hashState({ 0: 1 }));
    expect(hashState(new Uint8Array([1, 2]))).not.toBe(hashState(new Int8Array([1, 2])));
    expect(hashState('1')).not.toBe(hashState(1));
    expect(hashState(undefined)).not.toBe(hashState(null));
  });

  it('hashes typed-array contents, not the backing buffer', () => {
    const buf = new Uint8Array([9, 9, 1, 2, 9]);
    expect(hashState(buf.subarray(2, 4))).toBe(hashState(new Uint8Array([1, 2])));
  });

  it('folds -0 and NaN', () => {
    expect(hashState(-0)).toBe(hashState(0));
    expect(hashState(NaN)).toBe(hashState(Number.NaN));
  });

  it('pins a known value', () => {
    // An accidental change to the canonical walk shows up here: every stored
    // golden hash in a consumer's replay fixtures would silently go stale.
    expect(hashStateHex({ ram: new Uint8Array([1, 2, 3]), n: 1, s: 'x' })).toBe('8ce3ae1c');
    expect(hashState(snapshotState(makeState()))).toBe(hashState(makeState()));
  });
});

describe('RingBuffer', () => {
  it('evicts the oldest and pops the newest', () => {
    const rb = new RingBuffer<number>(3);
    expect(rb.push(1)).toBeUndefined();
    rb.push(2);
    rb.push(3);
    expect(rb.push(4)).toBe(1);
    expect(rb.toArray()).toEqual([2, 3, 4]);
    expect(rb.at(0)).toBe(2);
    expect(rb.at(-1)).toBe(4);
    expect(rb.peek()).toBe(4);
    expect(rb.pop()).toBe(4);
    expect(rb.pop()).toBe(3);
    rb.push(5);
    expect(rb.toArray()).toEqual([2, 5]);
    rb.clear();
    expect(rb.size).toBe(0);
    expect(rb.pop()).toBeUndefined();
  });

  it('rejects a bad capacity', () => {
    expect(() => new RingBuffer(0)).toThrow();
  });
});

describe('replays', () => {
  type Sim = { x: number; ram: Uint8Array; frame: number };
  const step = (s: Sim, inputs: number[]): void => {
    s.x += inputs[0]! & 1 ? 1 : 0;
    s.x -= inputs[1]! & 1 ? 2 : 0;
    s.ram[s.frame & 7] ^= s.x & 0xff;
    s.frame++;
  };
  const fresh = (): Sim => ({ x: 0, ram: new Uint8Array(8), frame: 0 });

  it('records and plays back interleaved masks', () => {
    const rec = new InputRecorder(2);
    rec.record([1, 0]);
    rec.record([1]);
    rec.record([0, 1]);
    const replay = rec.toReplay({ dips: { lives: 3 } });
    expect(replay.inputs).toEqual([1, 0, 1, 0, 0, 1]);
    expect(replayLength(replay)).toBe(3);
    expect(JSON.parse(JSON.stringify(replay))).toEqual(replay);

    const player = new ReplayPlayer(replay);
    expect(player.next()).toEqual([1, 0]);
    player.seek(2);
    expect(player.next()).toEqual([0, 1]);
    expect(player.next()).toBeNull();
    expect(player.done).toBe(true);

    rec.truncate(1);
    expect(rec.frames).toBe(1);
  });

  it('a replay reproduces the live run bit-for-bit', () => {
    const live = fresh();
    const rec = new InputRecorder(2);
    const liveHashes: number[] = [];
    for (let f = 0; f < 100; f++) {
      const inputs = [f % 3 === 0 ? 1 : 0, f % 7 === 0 ? 1 : 0];
      rec.record(inputs);
      step(live, inputs);
      liveHashes.push(hashState(live));
    }
    const { state, hashes } = runReplay({ state: fresh(), step, replay: rec.toReplay() });
    expect(hashState(state)).toBe(hashState(live));
    expect(hashes.map(([, h]) => h)).toEqual(liveHashes);
    expect(hashes[0]![0]).toBe(1);

    const sparse = runReplay({ state: fresh(), step, replay: rec.toReplay(), hashEvery: 30 });
    expect(sparse.hashes.map(([f]) => f)).toEqual([30, 60, 90, 100]);
  });

  it('rewind via snapshots in a ring buffer restores an earlier frame', () => {
    const s = fresh();
    const history = new RingBuffer<Sim>(10);
    const hashesAt: number[] = [];
    for (let f = 0; f < 20; f++) {
      history.push(snapshotState(s));
      hashesAt.push(hashState(s));
      step(s, [1, f & 1]);
    }
    history.pop(); // frame 19
    restoreState(s, history.pop()!); // frame 18
    expect(hashState(s)).toBe(hashesAt[18]);
  });
});

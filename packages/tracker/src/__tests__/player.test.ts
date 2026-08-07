import { describe, it, expect } from 'vitest';
import { TrackerPlayer } from '../player.ts';
import { buildAudibleMod } from './mod-fixture.ts';

/**
 * `TrackerPlayer` owns the Web Audio plumbing (AudioContext, worklet, gain
 * node), so `play()` past its early-return can't run under Node. Everything
 * either side of that — load/parse, the volume property, and the guards that
 * make stop/play safe to call in any order — is plain state and is covered
 * here.
 */
describe('TrackerPlayer', () => {
  it('starts unloaded and not playing', () => {
    const player = new TrackerPlayer();
    expect(player.loaded).toBe(false);
    expect(player.playing).toBe(false);
  });

  it('load() parses the module and flips `loaded`', async () => {
    const player = new TrackerPlayer();
    await player.load(buildAudibleMod());
    expect(player.loaded).toBe(true);
    expect(player.playing).toBe(false); // loading alone doesn't start audio
  });

  it('load() surfaces a malformed module as a throw', async () => {
    const player = new TrackerPlayer();
    const bad = buildAudibleMod();
    bad[1080] = bad[1081] = bad[1082] = bad[1083] = 0x5a; // destroy the format tag
    await expect(player.load(bad)).rejects.toThrow('MOD format not recognised');
    expect(player.loaded).toBe(false);
  });

  it('defaults the volume to 0.3 and stores an assignment made before playback', () => {
    const player = new TrackerPlayer();
    expect(player.volume).toBe(0.3);
    // No gain node exists yet; the setter must still remember the value so
    // play() can apply it later.
    player.volume = 0.75;
    expect(player.volume).toBe(0.75);
  });

  it('play() is a no-op when nothing is loaded (never touches AudioContext)', async () => {
    const player = new TrackerPlayer();
    await expect(player.play()).resolves.toBeUndefined();
    expect(player.playing).toBe(false);
  });

  it('stop() is safe to call when not playing, and is idempotent', async () => {
    const player = new TrackerPlayer();
    expect(() => player.stop()).not.toThrow();
    await player.load(buildAudibleMod());
    expect(() => player.stop()).not.toThrow();
    expect(() => player.stop()).not.toThrow();
    expect(player.playing).toBe(false);
  });

  it('exposes no pause() — the reason PlaybackEngine.pause is optional', () => {
    // @seer-project/core's PlaybackEngine deliberately makes `pause` optional
    // because this player has no paused state to resume from: stop() tears the
    // worklet down. An adapter must not be forced to fake one.
    const player = new TrackerPlayer();
    expect((player as unknown as { pause?: unknown }).pause).toBeUndefined();
    expect(typeof player.play).toBe('function');
    expect(typeof player.stop).toBe('function');
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { NativeAudioEngine } from '../native-audio-engine.ts';

/**
 * jsdom implements `<audio>` as a real DOM element but deliberately does NOT
 * implement `HTMLMediaElement` playback (`play()`/`pause()` throw "Not
 * implemented"). `NativeAudioEngine` only ever touches a small, well-defined
 * subset of the interface (src/load/play/pause/currentTime/duration/paused/
 * ended/volume + five event types), so this fake — a real `EventTarget`
 * with just that subset bolted on — exercises the engine's real logic
 * (event wiring, clamping, state derivation) without needing jsdom's
 * unimplemented media stack.
 */
class FakeAudioElement extends EventTarget {
  preload = '';
  src = '';
  currentTime = 0;
  duration = NaN;
  paused = true;
  ended = false;
  volume = 1;
  loadCalls = 0;
  playCalls = 0;
  pauseCalls = 0;
  removedAttr: string | null = null;

  load(): void {
    this.loadCalls++;
  }
  play(): Promise<void> {
    this.playCalls++;
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause(): void {
    this.pauseCalls++;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  removeAttribute(name: string): void {
    this.removedAttr = name;
    if (name === 'src') this.src = '';
  }
}

function makeEngine() {
  const el = new FakeAudioElement();
  const engine = new NativeAudioEngine({ element: el as unknown as HTMLAudioElement });
  return { el, engine };
}

describe('NativeAudioEngine', () => {
  it('load() sets src, calls load(), and defaults title to the url', () => {
    const { el, engine } = makeEngine();
    engine.load('/assets/track.mp3');
    expect(el.src).toBe('/assets/track.mp3');
    expect(el.loadCalls).toBe(1);
    expect(engine.getState().title).toBe('/assets/track.mp3');
  });

  it('load() accepts an explicit title/detail', () => {
    const { engine } = makeEngine();
    engine.load('/assets/track.mp3', { title: 'Boss Theme', detail: 'MPEG (MP3) · 44100 Hz · stereo' });
    const state = engine.getState();
    expect(state.title).toBe('Boss Theme');
    expect(state.detail).toBe('MPEG (MP3) · 44100 Hz · stereo');
  });

  it('load({ autoplay: true }) starts playback', () => {
    const { el, engine } = makeEngine();
    engine.load('/x.mp3', { autoplay: true });
    expect(el.playCalls).toBe(1);
    expect(engine.getState().isPlaying).toBe(true);
  });

  it('play()/pause() delegate to the element and getState() reflects paused/ended', () => {
    const { el, engine } = makeEngine();
    engine.play();
    expect(el.playCalls).toBe(1);
    expect(engine.getState().isPlaying).toBe(true);

    engine.pause();
    expect(el.pauseCalls).toBe(1);
    expect(engine.getState().isPlaying).toBe(false);

    el.paused = false;
    el.ended = true;
    expect(engine.getState().isPlaying).toBe(false); // ended overrides paused=false
  });

  it('getState() reports seekable/duration only once a finite positive duration is known', () => {
    const { el, engine } = makeEngine();
    expect(engine.getState().seekable).toBe(false);
    expect(engine.getState().duration).toBeNull();

    el.duration = 125.4;
    const state = engine.getState();
    expect(state.seekable).toBe(true);
    expect(state.duration).toBe(125.4);
  });

  it('seek() clamps into [0, duration] and no-ops without a known duration', () => {
    const { el, engine } = makeEngine();
    engine.seek(50);
    expect(el.currentTime).toBe(0); // no duration yet — no-op

    el.duration = 100;
    engine.seek(50);
    expect(el.currentTime).toBe(50);
    engine.seek(-10);
    expect(el.currentTime).toBe(0);
    engine.seek(9999);
    expect(el.currentTime).toBe(100);
  });

  it('setVolume() clamps into [0, 1]', () => {
    const { el, engine } = makeEngine();
    engine.setVolume(0.4);
    expect(el.volume).toBe(0.4);
    engine.setVolume(-1);
    expect(el.volume).toBe(0);
    engine.setVolume(5);
    expect(el.volume).toBe(1);
  });

  it('onStateChange fires on the element\'s playback events and the returned unsubscribe stops delivery', () => {
    const { el, engine } = makeEngine();
    const cb = vi.fn();
    const unsubscribe = engine.onStateChange(cb);

    el.dispatchEvent(new Event('timeupdate'));
    el.dispatchEvent(new Event('loadedmetadata'));
    el.dispatchEvent(new Event('play'));
    el.dispatchEvent(new Event('pause'));
    el.dispatchEvent(new Event('ended'));
    expect(cb).toHaveBeenCalledTimes(5);

    unsubscribe();
    el.dispatchEvent(new Event('timeupdate'));
    expect(cb).toHaveBeenCalledTimes(5);
  });

  it('dispose() pauses, clears the source, and stops forwarding element events', () => {
    const { el, engine } = makeEngine();
    engine.load('/x.mp3');
    const cb = vi.fn();
    engine.onStateChange(cb);

    engine.dispose();
    expect(el.pauseCalls).toBe(1);
    expect(el.removedAttr).toBe('src');
    expect(el.loadCalls).toBe(2); // once from load(), once from dispose()'s reset

    cb.mockClear();
    el.dispatchEvent(new Event('timeupdate'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('constructing without an element creates its own (no element option required)', () => {
    expect(() => new NativeAudioEngine()).not.toThrow();
  });

  it('disposing a superseded engine leaves the shared element alone', () => {
    // flower's pattern: one static <audio> reused across selections, a fresh
    // engine per track. AudioBarController.attach() disposes the *previous*
    // engine only after the new one has loaded and started the element, so a
    // blind teardown here would silently kill the track that just began.
    const el = new FakeAudioElement();
    const first = new NativeAudioEngine({ element: el as unknown as HTMLAudioElement });
    first.load('/a.mp3');

    const second = new NativeAudioEngine({ element: el as unknown as HTMLAudioElement });
    second.load('/b.mp3', { autoplay: true });
    expect(el.src).toBe('/b.mp3');

    first.dispose();
    expect(el.src).toBe('/b.mp3'); // not cleared out from under the new engine
    expect(el.paused).toBe(false); // and still playing

    // The superseded engine still releases its own element subscriptions.
    const cb = vi.fn();
    first.onStateChange(cb);
    el.dispatchEvent(new Event('timeupdate'));
    expect(cb).not.toHaveBeenCalled();

    // The current owner still tears the element down properly.
    second.dispose();
    expect(el.removedAttr).toBe('src');
    expect(el.paused).toBe(true);
  });

  it('dispose() is idempotent', () => {
    const { el, engine } = makeEngine();
    engine.load('/x.mp3');
    engine.dispose();
    const pausesAfterFirst = el.pauseCalls;
    expect(() => engine.dispose()).not.toThrow();
    expect(el.pauseCalls).toBe(pausesAfterFirst);
  });
});

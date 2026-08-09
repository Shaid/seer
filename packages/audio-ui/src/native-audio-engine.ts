import { attemptPlayback } from '@seer-project/core';
import type { PlaybackEngine, PlaybackState } from '@seer-project/core';

export interface NativeAudioEngineOptions {
  /**
   * Reuse an existing `<audio>` element — flower's original approach: one
   * static `display:none` element declared in `index.html` and kept alive
   * across track switches, so the browser doesn't have to spin up a new
   * decoder per selection. If omitted, a fresh (unattached, off-DOM)
   * `Audio()` element is created — `<audio>` playback doesn't require the
   * element to be present in the document, so this is fine for a project
   * (like hunter) that has no such static element in its `index.html` yet.
   */
  element?: HTMLAudioElement;
}

export interface LoadOptions {
  title?: string;
  detail?: string;
  /**
   * Start playing as soon as the source is set, same as flower's "selecting
   * an asset autoplays it" behavior. Autoplay-block rejections are swallowed
   * with a console warning, matching the original implementation — the user
   * can still hit the bar's play button manually.
   *
   * This overlaps with `AudioBarController.attach()`'s own `autoplay` option:
   * both ultimately call `play()`. Pick one — setting both on the same
   * selection calls `play()` twice (harmless on an `<audio>` element, which
   * ignores a play request for already-playing media, but it produces two
   * independent rejection warnings if autoplay is blocked). Load-time
   * autoplay is the better fit when the caller builds the engine itself
   * (flower/hunter); attach-time autoplay suits a long-lived engine whose
   * `load` happened earlier.
   */
  autoplay?: boolean;
}

/**
 * Which engine currently owns each `<audio>` element, so a disposed engine
 * can't tear down an element a *newer* engine has already taken over. Only
 * matters for the caller-supplied-element case: constructing an engine on an
 * element claims it, and `dispose()` skips element teardown unless the
 * disposing engine is still the claimant. Keyed weakly so an element going
 * out of scope isn't retained by this map.
 */
const elementOwner = new WeakMap<HTMLAudioElement, NativeAudioEngine>();

/**
 * `PlaybackEngine` wrapping a plain `<audio>` element — the engine for any
 * asset that's a real, directly playable, pre-decoded web audio file (mp3,
 * wav, ogg...). This is flower's original `#audio-player`/`drawAudioAsset`
 * logic (`docs/drakengard3/ps3/data-structure.md` §14) extracted into a
 * reusable, format-agnostic class — nothing here is Drakengard-specific.
 *
 * Not suitable for a format that needs to be *synthesized* rather than
 * decoded (Amiga FLT4 tracker modules, SMUS scores) — see `@seer-project/tracker`
 * and `@seer-project/smus` for those, wrapped by each project's own
 * `PlaybackEngine` adapter instead of this class.
 */
export class NativeAudioEngine implements PlaybackEngine {
  private el: HTMLAudioElement;
  private listeners = new Set<(state: PlaybackState) => void>();
  private unbindEl: (() => void) | null = null;
  private title = '';
  private detail: string | undefined;

  constructor(opts: NativeAudioEngineOptions = {}) {
    this.el = opts.element ?? new Audio();
    this.el.preload = 'auto';
    // Claim the element: whichever engine most recently wrapped it is the one
    // entitled to tear it down. See `dispose()`.
    elementOwner.set(this.el, this);

    const fire = () => this.fireUpdate();
    const events: Array<keyof HTMLMediaElementEventMap> = [
      'timeupdate',
      'loadedmetadata',
      'play',
      'pause',
      'ended',
    ];
    for (const type of events) this.el.addEventListener(type, fire);
    this.unbindEl = () => {
      for (const type of events) this.el.removeEventListener(type, fire);
    };
  }

  /** Points the engine at a new source URL. Does not implicitly stop() first — callers that reuse one engine instance across tracks should rely on `AudioBarController.attach()`'s dispose-on-switch behavior instead, or call `dispose()` themselves. */
  load(url: string, opts: LoadOptions = {}): void {
    this.title = opts.title ?? url;
    this.detail = opts.detail;
    this.el.src = url;
    this.el.load();
    if (opts.autoplay) {
      // Autoplay can be blocked by browser policy outside a user-gesture call
      // stack; the bar's own play button still works.
      attemptPlayback(
        () => this.play(),
        (err) => console.warn('Autoplay was blocked:', err),
      );
    }
    this.fireUpdate();
  }

  play(): void | Promise<void> {
    return this.el.play();
  }

  pause(): void {
    this.el.pause();
  }

  seek(seconds: number): void {
    const duration = this.el.duration;
    if (Number.isFinite(duration) && duration > 0) {
      this.el.currentTime = Math.max(0, Math.min(seconds, duration));
    }
  }

  setVolume(volume: number): void {
    this.el.volume = Math.max(0, Math.min(1, volume));
  }

  getState(): PlaybackState {
    const duration = this.el.duration;
    const common = {
      isPlaying: !this.el.paused && !this.el.ended,
      currentTime: this.el.currentTime,
      title: this.title,
      detail: this.detail,
      volume: this.el.volume,
    };
    // `duration` is NaN until metadata loads, and Infinity for a live stream —
    // neither is seekable. Branching here (rather than setting both fields
    // from one boolean) is what lets `PlaybackState`'s discriminated union
    // guarantee the two can never disagree.
    return Number.isFinite(duration) && duration > 0
      ? { ...common, seekable: true, duration }
      : { ...common, seekable: false, duration: null };
  }

  onStateChange(cb: (state: PlaybackState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Pauses and releases the source. The underlying `<audio>` element itself
   * is left intact (matching flower's `stopAudioPlayback`, which reuses
   * `#audio-player` forever rather than recreating it) — only its
   * `src`/listeners are cleared.
   *
   * The element teardown is skipped when a *newer* engine has since claimed
   * the same element. This is the normal case for the shared-element pattern
   * (`new NativeAudioEngine({ element })` per selection): the new engine is
   * constructed and `load()`ed first, and only then does
   * `AudioBarController.attach()` dispose the previous one — pausing and
   * clearing `src` here would silently kill the track that just started.
   * Listener unbinding always happens, so a superseded engine still releases
   * its element subscriptions rather than leaking them.
   *
   * Idempotent: disposing twice is a no-op the second time.
   */
  dispose(): void {
    if (elementOwner.get(this.el) === this) {
      elementOwner.delete(this.el);
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    }
    this.unbindEl?.();
    this.unbindEl = null;
    this.listeners.clear();
  }

  private fireUpdate(): void {
    const state = this.getState();
    for (const cb of this.listeners) cb(state);
  }
}

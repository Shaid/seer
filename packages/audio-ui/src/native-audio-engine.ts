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
  /** Start playing as soon as the source is set, same as flower's "selecting an asset autoplays it" behavior. Autoplay-block rejections are swallowed with a console warning, matching the original implementation — the user can still hit the bar's play button manually. */
  autoplay?: boolean;
}

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

    const fire = () => this.fireUpdate();
    const events: Array<keyof HTMLMediaElementEventMap> = ['timeupdate', 'loadedmetadata', 'play', 'pause', 'ended'];
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
      const p = this.el.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err: unknown) => {
          // Autoplay can be blocked by browser policy outside a user-gesture
          // call stack; the bar's own play button still works.
          console.warn('Autoplay was blocked:', err);
        });
      }
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
    const hasDuration = Number.isFinite(duration) && duration > 0;
    return {
      isPlaying: !this.el.paused && !this.el.ended,
      currentTime: this.el.currentTime,
      duration: hasDuration ? duration : null,
      seekable: hasDuration,
      title: this.title,
      detail: this.detail,
      volume: this.el.volume,
    };
  }

  onStateChange(cb: (state: PlaybackState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Pauses and releases the source. The underlying `<audio>` element itself is left intact (matching flower's `stopAudioPlayback`, which reuses `#audio-player` forever rather than recreating it) — only its `src`/listeners are cleared. */
  dispose(): void {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.unbindEl?.();
    this.unbindEl = null;
    this.listeners.clear();
  }

  private fireUpdate(): void {
    const state = this.getState();
    for (const cb of this.listeners) cb(state);
  }
}

import { formatClock } from '@seer-project/core';
import type { PlaybackEngine, PlaybackState } from '@seer-project/core';

/** Shows/hides an element via the `.hidden { display: none }` class every seer project's own `viewer.css` already defines — the exact convention independently duplicated as `setHidden()` in flower/wyrm/middilgard/hunter's own `shared.ts`. Re-implemented here (rather than imported) so this package has no dependency on any consumer project's local module. */
function setHidden(el: HTMLElement, hidden: boolean): void {
  el.classList.toggle('hidden', hidden);
}

/**
 * The DOM elements one audio bar is built from. Only `bar`, `toggleBtn`, and
 * `timeLabel` are required — matching the minimum every real project's own
 * panel already had (a show/hide container, a play/pause button, and a
 * status/info line). `seekInput`, `stopBtn`, and `volumeInput` are optional
 * extension points: each is shown only when both the DOM element was
 * supplied *and* the currently attached engine implements the matching
 * optional `PlaybackEngine` method (`seek`/`stop`/`setVolume`) — so flower's
 * bar (seek, no stop/volume), wyrm's panel (stop + volume, no seek — a
 * live-synthesized tracker module has no fixed timeline to seek within),
 * and hunter's bar (seek only, same shape as flower's) each render exactly
 * the controls their engine can actually act on.
 */
export interface AudioBarElements {
  bar: HTMLElement;
  toggleBtn: HTMLButtonElement;
  timeLabel: HTMLElement;
  seekInput?: HTMLInputElement;
  stopBtn?: HTMLButtonElement;
  volumeInput?: HTMLInputElement;
}

export interface AttachOptions {
  /**
   * Start playback immediately on attach — flower's "selecting an asset
   * autoplays it" behavior. Rejected autoplay promises are swallowed with a
   * console warning; the bar's own play button still works.
   *
   * Note this overlaps with `NativeAudioEngine.load()`'s own `autoplay`
   * option — both end up calling `play()`, so setting both for one selection
   * calls it twice. Use whichever layer owns the "should this start
   * playing?" decision, not both.
   */
  autoplay?: boolean;
}

/**
 * Generic, engine-agnostic controller for a bottom-docked audio transport
 * bar — the shared UI layer this package exists to provide. Wires a fixed
 * set of DOM elements once, in the constructor; `attach(engine)` points it
 * at whichever `PlaybackEngine` the caller loaded (a `NativeAudioEngine`, a
 * project's own tracker/SMUS adapter, anything implementing the interface)
 * and the controller drives play/pause/seek/volume and reflects state
 * changes for as long as that engine stays attached.
 *
 * One controller instance is meant to live for the lifetime of the page
 * (constructed once, like flower's original module-level `#audio-bar`
 * wiring) and have `attach()`/`detach()` called on every asset
 * selection/deselection — exactly the pattern all three real projects
 * already used per-engine before this package existed.
 */
export class AudioBarController {
  private els: AudioBarElements;
  private engine: PlaybackEngine | null = null;
  /**
   * An engine that `detach()` released but deliberately did *not* dispose,
   * kept only so re-attaching the same instance can resurrect it. Disposed
   * as soon as a *different* engine is attached (or the controller itself is
   * disposed), which is what keeps the create-an-engine-per-track callers
   * from leaking one engine per switch away from audio.
   */
  private detached: PlaybackEngine | null = null;
  private unsubscribe: (() => void) | null = null;
  private seeking = false;
  private teardownStatic: Array<() => void> = [];

  constructor(elements: AudioBarElements) {
    this.els = elements;
    this.bindStaticControls();
    setHidden(this.els.bar, true);
  }

  private on(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.teardownStatic.push(() => target.removeEventListener(type, fn));
  }

  /**
   * Calls `play()` and swallows failure as a console warning, whether the
   * engine reports it by rejecting or by throwing synchronously — `play()`
   * is typed `void | Promise<void>`, so a synchronous throw (an
   * unloaded-track guard, a failed `AudioContext.resume()`) is a legal way
   * for an engine to fail and must not escape a click handler uncaught.
   */
  private safePlay(engine: PlaybackEngine, message: string): void {
    try {
      Promise.resolve(engine.play()).catch((err: unknown) => console.warn(message, err));
    } catch (err) {
      console.warn(message, err);
    }
  }

  /**
   * The seek slider's own `min`/`max` define its scale — read from the
   * element rather than assuming one, so markup using HTML's default 0-100
   * range works identically to the 0-1000 range every real project's viewer
   * uses for sub-second resolution. Falls back to the HTML defaults when the
   * attributes are absent.
   */
  private seekRange(): { min: number; span: number } {
    const el = this.els.seekInput!;
    const min = Number(el.min || 0);
    const max = Number(el.max || 100);
    return { min, span: max - min };
  }

  /** Where the slider's thumb currently sits, as a 0..1 fraction of its range. */
  private seekFraction(): number {
    const { min, span } = this.seekRange();
    if (!(span > 0)) return 0;
    return (Number(this.els.seekInput!.value) - min) / span;
  }

  /** Moves the thumb to a 0..1 fraction of the slider's range. */
  private setSeekFraction(fraction: number): void {
    const { min, span } = this.seekRange();
    this.els.seekInput!.value = String(Math.round(min + fraction * span));
  }

  private bindStaticControls(): void {
    this.on(this.els.toggleBtn, 'click', () => {
      if (!this.engine) return;
      if (this.engine.getState().isPlaying) {
        // `pause()` keeps position so `play()` resumes, which is what the
        // toggle means — but it's optional, so an engine that only has
        // `stop()` (a tracker that tears its worklet down) degrades to that.
        if (this.engine.pause) this.engine.pause();
        else this.engine.stop?.();
      } else {
        this.safePlay(this.engine, 'Playback failed:');
      }
    });

    if (this.els.stopBtn) {
      this.on(this.els.stopBtn, 'click', () => this.engine?.stop?.());
    }

    if (this.els.seekInput) {
      this.on(this.els.seekInput, 'input', () => {
        if (!this.engine?.seek) return;
        this.seeking = true;
        const state = this.engine.getState();
        if (state.duration !== null) {
          this.engine.seek(this.seekFraction() * state.duration);
        }
        this.render(this.engine.getState());
      });
      this.on(this.els.seekInput, 'change', () => {
        this.seeking = false;
      });
    }

    if (this.els.volumeInput) {
      this.on(this.els.volumeInput, 'input', () => {
        this.engine?.setVolume?.(Number(this.els.volumeInput!.value) / 100);
      });
    }
  }

  /**
   * Points the bar at an engine. Disposes whatever *different* engine was
   * attached before (mirrors every project's pre-existing "switching asset
   * stops the old one" behavior — flower's `stopAudioPlayback`,
   * middilgard's `.stop()`-on-deselect calls), shows the bar, toggles
   * `stopBtn`/`volumeInput` visibility to match what this engine actually
   * supports, and renders its current state immediately.
   *
   * Re-attaching the *same* engine instance (`engine === this.engine`) is a
   * refresh, not a teardown: it neither disposes nor re-subscribes, just
   * re-renders and (if requested) plays. This matters for an engine that
   * wraps one long-lived underlying player across every track selection
   * rather than being recreated per track — wyrm's `TrackerPlaybackEngine`
   * wraps a single persistent `MusicPlayer`, and `MusicPlayer` itself
   * already has its own "don't restart an already-loaded song" guard
   * (`loadSong`'s caller checks `songId` first) — disposing on every
   * reselect of an already-playing track here would stop it regardless of
   * that guard, which is not what any pre-migration project did.
   *
   * Re-attaching an engine that `detach()` released is likewise safe: it was
   * stopped but not disposed, so this simply re-subscribes to it. That is
   * what makes the documented attach/detach/attach cycle over one
   * module-level engine work.
   */
  attach(engine: PlaybackEngine, opts: AttachOptions = {}): void {
    if (engine !== this.engine) {
      // A genuinely different engine is taking over: the one we're currently
      // subscribed to is finished, and so is any engine `detach()` parked for
      // possible reuse (re-attaching *this* one proves it wasn't reused).
      this.disposeEngine(this.engine);
      if (this.detached !== engine) this.disposeEngine(this.detached);
      this.detached = null;

      this.engine = engine;
      this.unsubscribe = engine.onStateChange((state) => this.render(state));
      if (this.els.stopBtn) setHidden(this.els.stopBtn, !engine.stop);
      if (this.els.volumeInput) setHidden(this.els.volumeInput, !engine.setVolume);
    }

    setHidden(this.els.bar, false);
    this.render(engine.getState());

    if (opts.autoplay) {
      this.safePlay(engine, 'Autoplay was blocked:');
    }
  }

  /**
   * Stops the current engine, unsubscribes from it, and hides the bar. Call
   * on every asset switch away from an audio entry and on viewer teardown —
   * mirrors `stopAudioPlayback()`/`stopMeshViewer()`'s existing
   * self-contained cleanup pattern.
   *
   * Deliberately does **not** `dispose()` the engine. The same instance may
   * legitimately be attached again later — wyrm's and middilgard's engines
   * are constructed once and stored in a module-level `const`, so disposing
   * here would leave a re-`attach()` silently wired to a dead engine (a bar
   * that renders once and then never updates). Playback is stopped instead,
   * which is the observable behavior callers actually depend on. The parked
   * engine is disposed as soon as a different one is attached, or when the
   * controller itself is disposed, so nothing leaks.
   */
  detach(): void {
    if (this.engine) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      // `stop()` when the engine has one (a hard reset to the start), else
      // `pause()` — either way the track is no longer audible. Both are
      // optional, so an engine implementing neither simply keeps playing;
      // the contract asks for at least one.
      if (this.engine.stop) this.engine.stop();
      else this.engine.pause?.();
      this.detached = this.engine;
      this.engine = null;
    }
    setHidden(this.els.bar, true);
  }

  private disposeEngine(engine: PlaybackEngine | null): void {
    if (!engine) return;
    if (engine === this.engine) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.engine = null;
    }
    if (engine === this.detached) this.detached = null;
    engine.dispose();
  }

  private render(state: PlaybackState): void {
    this.els.toggleBtn.textContent = state.isPlaying ? '⏸' : '▶';
    this.els.toggleBtn.classList.toggle('playing', state.isPlaying);

    // A non-seekable engine (e.g. a live-synthesized tracker module with no
    // fixed wall-clock timeline — see docs/audio-playback.md) hides the
    // slider (if one was even supplied — wyrm's panel has none) and shows
    // `detail` text where the time readout would go, rather than rendering
    // a seek control that can't do anything.
    if (this.els.seekInput) {
      // Gated on the engine implementing `seek()` as well as on `seekable`,
      // matching `stopBtn`/`volumeInput` and `AudioBarElements`' documented
      // contract: `seek` is optional, so an engine can know its duration
      // without being able to act on a seek request. Showing a live slider
      // whose drag handler silently no-ops would be worse than showing none.
      const canSeek = state.seekable && !!this.engine?.seek;
      setHidden(this.els.seekInput, !canSeek);
      if (canSeek && !this.seeking) {
        this.setSeekFraction(state.duration ? state.currentTime / state.duration : 0);
      }
    }
    this.els.timeLabel.textContent = state.seekable
      ? `${formatClock(state.currentTime)} / ${formatClock(state.duration)}`
      : (state.detail ?? state.title);

    if (this.els.volumeInput && state.volume !== undefined) {
      // Don't fight an in-progress drag on the volume slider itself.
      if (document.activeElement !== this.els.volumeInput) {
        this.els.volumeInput.value = String(Math.round(state.volume * 100));
      }
    }
  }

  /** Tears down the controller itself — unbinds the static element listeners bound in the constructor and disposes any attached engine. Call when the bar's elements are being removed from the page entirely (not needed for ordinary asset-to-asset switching — use `detach()`/`attach()` for that). */
  dispose(): void {
    this.disposeEngine(this.engine);
    this.disposeEngine(this.detached);
    for (const off of this.teardownStatic) off();
    this.teardownStatic = [];
  }
}

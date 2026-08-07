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
  /** Start playback immediately on attach — flower's "selecting an asset autoplays it" behavior. Rejected autoplay promises are swallowed with a console warning; the bar's own play button still works. */
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

  private bindStaticControls(): void {
    this.on(this.els.toggleBtn, 'click', () => {
      if (!this.engine) return;
      if (this.engine.getState().isPlaying) {
        this.engine.pause();
      } else {
        Promise.resolve(this.engine.play()).catch((err: unknown) => console.warn('Playback failed:', err));
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
          this.engine.seek((Number(this.els.seekInput!.value) / 1000) * state.duration);
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
   */
  attach(engine: PlaybackEngine, opts: AttachOptions = {}): void {
    if (engine !== this.engine) {
      this.detachEngine();
      this.engine = engine;
      this.unsubscribe = engine.onStateChange((state) => this.render(state));
      if (this.els.stopBtn) setHidden(this.els.stopBtn, !engine.stop);
      if (this.els.volumeInput) setHidden(this.els.volumeInput, !engine.setVolume);
    }

    setHidden(this.els.bar, false);
    this.render(engine.getState());

    if (opts.autoplay) {
      Promise.resolve(engine.play()).catch((err: unknown) => console.warn('Autoplay was blocked:', err));
    }
  }

  /** Detaches and disposes the current engine (if any) and hides the bar. Call on every asset switch away from an audio entry and on viewer teardown — mirrors `stopAudioPlayback()`/`stopMeshViewer()`'s existing self-contained cleanup pattern. */
  detach(): void {
    this.detachEngine();
    setHidden(this.els.bar, true);
  }

  private detachEngine(): void {
    if (!this.engine) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.engine.dispose();
    this.engine = null;
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
      this.els.seekInput.style.display = state.seekable ? '' : 'none';
      if (state.seekable && !this.seeking) {
        this.els.seekInput.value = state.duration ? String(Math.round((state.currentTime / state.duration) * 1000)) : '0';
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
    this.detachEngine();
    for (const off of this.teardownStatic) off();
    this.teardownStatic = [];
  }
}

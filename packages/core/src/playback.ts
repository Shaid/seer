/**
 * Shared playback-engine contract for the viewer's bottom-docked audio bar
 * (flower's `#audio-bar`, wyrm's `#music-panel`, middilgard's
 * `#music-strip` — see `docs/audio-playback.md` for the full design and
 * migration history).
 *
 * This interface deliberately covers only the *transport surface* the
 * shared UI (`@seer-project/audio-ui`'s `AudioBarController`) needs — play, pause,
 * optional stop, optional seek, optional volume, a state snapshot, and a
 * change subscription. It does NOT standardize how a track is *loaded*:
 * flower's native-`<audio>` engine needs a URL, wyrm's FLT4 tracker engine
 * needs a song id + asset base + compression format, middilgard's SMUS
 * engine needs a manifest entry plus two data directories. Each concrete
 * engine keeps its own project/format-specific `load(...)` method; the
 * viewer's own code calls that, then hands the resulting object — typed as
 * `PlaybackEngine` — to `AudioBarController`, which only ever calls the
 * methods declared here.
 *
 * Real playback is a genuinely different problem per format (decoding a
 * pre-existing file vs. live-synthesizing one from tracker/score data), so
 * this package intentionally does not attempt to unify engines — only the
 * chrome around them. See `@seer-project/tracker` and `@seer-project/smus` for the two real
 * synthesis engines, and `@seer-project/audio-ui`'s `NativeAudioEngine` for the
 * pre-decoded-file case.
 */

/** A snapshot of one `PlaybackEngine`'s current playback status. */
export interface PlaybackState {
  /** True while audio is actively playing. */
  isPlaying: boolean;
  /**
   * Elapsed playback position, in seconds. Still meaningful when
   * `seekable` is false (e.g. a tick-driven tracker engine can report
   * elapsed wall-clock time even though it has no fixed-duration
   * timeline to seek within) — but not guaranteed to relate to `duration`
   * in that case.
   */
  currentTime: number;
  /**
   * Total duration in seconds, or `null` when unknown or not applicable.
   * Always `null` for an engine whose `seekable` is false in every engine
   * shipped so far (a live-synthesized tracker module's length depends on
   * mid-song tempo effects this engine doesn't simulate ahead of time).
   */
  duration: number | null;
  /**
   * Whether `seek()` has any real effect right now. The shared UI hides
   * the seek slider and shows `detail` text instead of a time readout
   * when this is false — see `docs/audio-playback.md`'s "seek is not
   * universal" design note.
   */
  seekable: boolean;
  /** Primary label — track/song/asset title. */
  title: string;
  /**
   * Optional secondary line shown next to (seekable engines) or instead
   * of (non-seekable engines) the time readout — codec info, order/row
   * position, track/instrument counts, whatever the concrete engine wants
   * to surface.
   */
  detail?: string;
  /** 0..1 output volume, present only when the engine implements `setVolume`. */
  volume?: number;
}

/**
 * The contract `AudioBarController` (`@seer-project/audio-ui`) drives. Every method
 * except `play`, `pause`, `getState`, `onStateChange`, and `dispose` is
 * optional — the shared UI only renders the controls an engine actually
 * supports (a Stop button only when `stop` is present, a seek slider only
 * when `getState().seekable` is true, a volume slider only when `setVolume`
 * is present), rather than forcing false symmetry across genuinely
 * different playback engines.
 */
export interface PlaybackEngine {
  play(): void | Promise<void>;
  pause(): void;
  /**
   * Optional hard reset to the start, distinct from `pause()` — e.g.
   * wyrm's tracker engine resets its order/row position to zero so the
   * next `play()` restarts rather than resumes, whereas `pause()` alone
   * keeps position. Omit when `pause()` already fully resets (true of
   * both flower's and middilgard's engines) — the shared UI then shows no
   * separate Stop button.
   */
  stop?(): void;
  /**
   * Optional absolute seek, in seconds. Omit — or report
   * `getState().seekable === false` — for an engine with no stable
   * wall-clock timeline to seek within.
   */
  seek?(seconds: number): void;
  /** Optional volume control, 0..1. */
  setVolume?(volume: number): void;
  getState(): PlaybackState;
  /** Subscribe to state changes; returns an unsubscribe function. */
  onStateChange(cb: (state: PlaybackState) => void): () => void;
  /**
   * Release all resources this engine holds (timers, `AudioContext`,
   * event listeners, `<audio>` element bindings). Called by
   * `AudioBarController` whenever it's detached or re-attached to a
   * different engine — always call this yourself too if you ever bypass
   * the controller.
   */
  dispose(): void;
}

/**
 * `mm:ss` formatting for a playback position or duration — the one bit of
 * display logic all three real engines independently reimplemented
 * (flower's `formatClock`, wyrm's and middilgard's inline equivalents).
 * Returns `"0:00"` for `null`/`undefined`/negative/non-finite input rather
 * than throwing, since `duration` is routinely `null` before metadata
 * loads or for a non-seekable engine.
 */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

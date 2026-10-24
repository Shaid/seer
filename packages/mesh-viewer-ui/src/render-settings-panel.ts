import {
  downloadScreenshot,
  downloadClip,
  recordClip,
  type CaptureSource,
} from '@seer-project/canvas-export';
import {
  createTurntable,
  isPhotoModeAvailable,
  type MeshSession,
  type CinematicOptions,
} from '@seer-project/engine-3d';
import { PanelController, setHidden } from './panel-controller.js';

export type RenderQuality = 'flat' | 'cinematic' | 'photo';

/**
 * The DOM elements one render-settings panel is built from — same
 * host-owns-the-markup division of labor as `MeshSettingsPanelElements`.
 * `<option>` values on `qualitySelect` must be exactly `'flat'\|'cinematic'\|'photo'`.
 */
export interface RenderSettingsPanelElements {
  /** Toolbar button that opens/closes `panel`. Hidden by `detach()`, shown by `attach()`. */
  toggleBtn: HTMLButtonElement;
  panel: HTMLElement;
  qualitySelect: HTMLSelectElement;
  shadowsCheckbox: HTMLInputElement;
  screenshotBtn: HTMLButtonElement;
  recordTurntableBtn: HTMLButtonElement;
  /**
   * Bloom/AO/DOF sub-toggles, under `cinematic` only, and the row that
   * groups them (`refresh()` toggles its `hidden` class). All optional
   * together — a reduced panel (same allowance `MeshSettingsPanel` gives
   * chimera) can omit per-effect control entirely and only offer the
   * `cinematic` tier as one fixed bundle.
   */
  cinematicOptionsRow?: HTMLElement;
  bloomCheckbox?: HTMLInputElement;
  aoCheckbox?: HTMLInputElement;
  dofCheckbox?: HTMLInputElement;
  /** Sub-row under `photo` only, and the element its live phase/progress text is written into — both optional together. `refresh()` toggles the row's `hidden` class and keeps the status text live while tracing. */
  photoModeRow?: HTMLElement;
  photoModeStatus?: HTMLElement;
}

export interface RenderSettingsPanelOptions {
  /** Builds the watermark text baked into both the screenshot and the recorded clip — only the host knows asset/game/platform names (same convention as `canvas-export`'s watermark, see `render-quality-proposal.md`). */
  watermarkText(session: MeshSession): string;
  /** Filename base (no extension) for both exports. Defaults to `'model'`. */
  fileName?(session: MeshSession): string;
  /** Turntable recording: `durationSeconds` is both the clip length and one full 360° rotation (default `4`); `fps` is the sampled frame rate (default `30`). */
  turntable?: { durationSeconds?: number; fps?: number };
  /** How often (ms) to refresh `photoModeStatus`'s text while tracing, since `session.photoMode`/its sample count aren't independently observable. Default `250`. */
  photoModePollMs?: number;
  /**
   * Called after this panel applies a user-initiated render-tier change
   * (the `qualitySelect` control). Nothing in `MeshSettingsPanel` currently
   * reads any state this panel owns, so this has no effect on it today — it
   * exists for symmetry with `MeshSettingsPanelOptions.onChange` and so a
   * host can wire it to the mesh-settings panel's `refresh()` without this
   * package needing to grow a real cross-panel dependency. Not called from
   * `refresh()` itself, so wiring both panels' `onChange` to each other's
   * `refresh()` can't recurse.
   */
  onChange?: () => void;
}

const DEFAULT_CINEMATIC: Required<Pick<CinematicOptions, 'bloom' | 'ao' | 'dof'>> = {
  bloom: {},
  ao: {},
  dof: {},
};

/**
 * 3D render-quality controls — a render-tier selector (`flat`/`cinematic`/
 * `photo`), shadows, cinematic's bloom/AO/DOF toggles, photo-mode progress,
 * and the two export buttons. Export lives here, not in `engine-3d`: this
 * panel builds the `CaptureSource`/watermark text/recording driver from the
 * attached `MeshSession` and hands them straight to `canvas-export` — it
 * contains no capture or encoding logic of its own.
 *
 * Same attach/refresh/detach/dispose, host-owns-DOM contract as
 * `MeshSettingsPanel`; a second, independent popover on the same toolbar.
 *
 * Independent also means uncoupled: this panel's own `refresh()` gates the
 * `photo` option and the shadows checkbox off `session.renderMode`/
 * `session.shading`, but those only change through `MeshSettingsPanel`, and
 * neither panel notifies the other. A host running both together should
 * wire `MeshSettingsPanelOptions.onChange` to this panel's `refresh()` (and,
 * symmetrically, `RenderSettingsPanelOptions.onChange` to
 * `MeshSettingsPanel.refresh()`) so a render-mode/shading change made in one
 * panel is reflected in the other without a page-level poll.
 *
 * The attach/refresh/detach/dispose lifecycle, the listener-teardown list and
 * the popover wiring all come from `PanelController`, shared with
 * `MeshSettingsPanel`; this panel's extra teardown (the photo-mode poll and
 * an in-flight recording) rides on that base's `onDetach()` hook, so
 * `detach()` and `dispose()` can't drift apart on it again.
 */
export class RenderSettingsPanel extends PanelController<MeshSession> {
  private els: RenderSettingsPanelElements;
  private opts: RenderSettingsPanelOptions;
  private photoModeAvailable = true;
  private photoModePollTimer: ReturnType<typeof setInterval> | null = null;
  private recording = false;
  private recordingAbort: AbortController | null = null;

  constructor(elements: RenderSettingsPanelElements, opts: RenderSettingsPanelOptions) {
    super(elements.toggleBtn, elements.panel);
    this.els = elements;
    this.opts = opts;
    this.bindStaticControls();
    void isPhotoModeAvailable().then((available) => {
      this.photoModeAvailable = available;
      this.refresh();
    });
  }

  /** Absent toggles default to on — a reduced panel with no per-effect controls gets the full cinematic bundle from selecting the tier alone. */
  private currentCinematicOptions(): CinematicOptions {
    return {
      bloom: this.els.bloomCheckbox && !this.els.bloomCheckbox.checked ? false : DEFAULT_CINEMATIC.bloom,
      ao: this.els.aoCheckbox && !this.els.aoCheckbox.checked ? false : DEFAULT_CINEMATIC.ao,
      dof: this.els.dofCheckbox && !this.els.dofCheckbox.checked ? false : DEFAULT_CINEMATIC.dof,
    };
  }

  /** The panel has no other way to surface an async action's failure to the host — at minimum this must not be an unhandled rejection. */
  private reportError(action: string, err: unknown): void {
    console.error(`RenderSettingsPanel: ${action} failed`, err);
  }

  private applyQuality(): void {
    if (!this.session) return;
    const quality = this.els.qualitySelect.value as RenderQuality;
    if (quality !== 'photo') {
      void this.session.setPhotoMode(false).catch((err) => {
        this.reportError('turning photo mode off', err);
        this.refresh();
      });
    }
    if (quality !== 'cinematic') this.session.setCinematic(false);
    if (quality === 'cinematic') this.session.setCinematic(this.currentCinematicOptions());
    if (quality === 'photo') {
      void this.session.setPhotoMode({}).catch((err) => {
        this.reportError('switching to photo mode', err);
        this.refresh();
      });
    }
    this.refresh();
    this.opts.onChange?.();
  }

  private applyCinematicOptions(): void {
    if (!this.session) return;
    if (this.els.qualitySelect.value !== 'cinematic') return;
    this.session.setCinematic(this.currentCinematicOptions());
  }

  private stopPhotoModePoll(): void {
    if (this.photoModePollTimer !== null) {
      clearInterval(this.photoModePollTimer);
      this.photoModePollTimer = null;
    }
  }

  private startPhotoModePoll(): void {
    this.stopPhotoModePoll();
    this.photoModePollTimer = setInterval(() => this.refreshPhotoModeStatus(), this.opts.photoModePollMs ?? 250);
  }

  private refreshPhotoModeStatus(): void {
    if (!this.session) return;
    const phase = this.session.photoMode;
    if (this.els.photoModeStatus) {
      this.els.photoModeStatus.textContent =
        phase === 'loading' ? 'Loading…' : phase === 'tracing' ? 'Tracing…' : phase === 'converged' ? 'Converged' : '';
    }
    // Keep polling for as long as the photo tier itself is active, not
    // merely while `phase` is still 'tracing'/'loading' — `phase` is
    // computed live off `pathTracer.samples`, and every controls 'change'
    // event (the user orbiting the model) resets accumulation via
    // `pathTracer.updateCamera()` (see `photo-mode.ts`), dropping samples
    // — and therefore `phase` — back below `targetSamples` with nothing
    // else calling `refresh()` to notice. Stopping the poll right at
    // 'converged' left the displayed status stuck there indefinitely after
    // any post-convergence camera move; polling through 'converged' means
    // the next tick picks the reset back up.
    if (phase !== 'off') this.startPhotoModePoll();
    else this.stopPhotoModePoll();
  }

  private async runScreenshot(): Promise<void> {
    if (!this.session) return;
    const source: CaptureSource = { canvas: this.session.viewport.renderer.domElement };
    const fileName = this.opts.fileName?.(this.session) ?? 'model';
    await downloadScreenshot(source, fileName, { watermark: { text: this.opts.watermarkText(this.session) } });
  }

  private async runRecordTurntable(): Promise<void> {
    if (!this.session || this.recording) return;
    // Defense in depth beyond the disabled button in refresh() — turntable
    // recording is broken under the photo tier (see refresh()'s own
    // comment), so refuse even if something reaches this method directly.
    if (this.els.qualitySelect.value === 'photo') return;
    this.recording = true;
    this.els.recordTurntableBtn.disabled = true;
    const session = this.session;
    const durationSeconds = this.opts.turntable?.durationSeconds ?? 4;
    const fps = this.opts.turntable?.fps ?? 30;
    const turntable = createTurntable(session.viewport, { durationSeconds, loops: 1 });
    const source: CaptureSource = {
      canvas: session.viewport.renderer.domElement,
      renderNow: () => {
        turntable.step(1 / fps);
        // `viewport.renderNow()` deliberately skips every frame hook and
        // `onFrame` (see its own doc comment) — a synchronous capture
        // shouldn't advance state as a side effect of being read. That
        // means a recorded clip must drive the animation mixer and any
        // active spring-bone solver by hand, the same way it already drove
        // the turntable, or an animated/clothed asset would record as a
        // single frozen frame repeated for the whole clip's duration.
        session.animation?.update(1 / fps);
        session.stepSpringBones(1 / fps);
        session.viewport.renderNow();
      },
    };
    // Aborted from detach()/dispose() — without this, switching assets or
    // tearing down the host mid-recording leaves recordClip()'s loop
    // calling viewport.renderNow() on a session that's about to be (or
    // already has been) disposed for the remainder of the clip.
    const abort = new AbortController();
    this.recordingAbort = abort;
    try {
      const result = await recordClip(source, {
        driver: { start() {}, stop() {} },
        fps,
        durationSeconds,
        watermark: { text: this.opts.watermarkText(session) },
        signal: abort.signal,
      });
      // A signal-aborted recording still resolves (with whatever prefix of
      // frames it managed) rather than rejecting — downloading that partial
      // clip is only useful for a deliberate abort, not the teardown case
      // this exists for, so skip it here specifically.
      if (!abort.signal.aborted) downloadClip(result, this.opts.fileName?.(session) ?? 'model');
    } finally {
      turntable.dispose();
      this.recording = false;
      this.els.recordTurntableBtn.disabled = false;
      if (this.recordingAbort === abort) this.recordingAbort = null;
    }
  }

  private bindStaticControls(): void {
    this.on(this.els.qualitySelect, 'change', () => this.applyQuality());
    this.on(this.els.shadowsCheckbox, 'change', () => {
      this.session?.setShadows(this.els.shadowsCheckbox.checked);
    });
    if (this.els.bloomCheckbox) this.on(this.els.bloomCheckbox, 'change', () => this.applyCinematicOptions());
    if (this.els.aoCheckbox) this.on(this.els.aoCheckbox, 'change', () => this.applyCinematicOptions());
    if (this.els.dofCheckbox) this.on(this.els.dofCheckbox, 'change', () => this.applyCinematicOptions());

    this.on(this.els.screenshotBtn, 'click', () => {
      void this.runScreenshot().catch((err) => this.reportError('capturing a screenshot', err));
    });
    this.on(this.els.recordTurntableBtn, 'click', () => {
      void this.runRecordTurntable().catch((err) => this.reportError('recording a turntable clip', err));
    });
  }

  /**
   * Stops the photo-mode status poll and aborts an in-flight turntable
   * recording — the session it renders through may be about to be disposed.
   * Runs from both `detach()` and `dispose()` (see `PanelController`).
   */
  protected override onDetach(): void {
    this.stopPhotoModePoll();
    this.recordingAbort?.abort();
  }

  /**
   * Re-syncs every control's displayed value/disabled-state from the
   * attached session's current state, including which sub-option rows
   * (`cinematicOptionsRow`/`photoModeRow`) are shown for the current tier.
   * Call again after `session.setModel()` resolves, same as
   * `MeshSettingsPanel.refresh()`.
   */
  refresh(): void {
    if (!this.session) return;
    const { session } = this;

    const quality: RenderQuality = session.photoMode !== 'off' ? 'photo' : session.cinematic !== false ? 'cinematic' : 'flat';
    this.els.qualitySelect.value = quality;

    const photoOption = Array.from(this.els.qualitySelect.options).find((o) => o.value === 'photo');
    if (photoOption) {
      const renderMode = session.renderMode;
      const unsupportedRenderMode = renderMode === 'wireframe' || renderMode === 'points';
      photoOption.disabled = !this.photoModeAvailable || unsupportedRenderMode;
      photoOption.title = !this.photoModeAvailable
        ? 'Photo mode is unavailable in this build'
        : unsupportedRenderMode
          ? 'Photo mode needs a shaded render mode'
          : '';
    }

    this.els.shadowsCheckbox.checked = session.shadows;
    // Shadows are a real toggle but a visual no-op on any material that
    // doesn't respond to lighting -- 'unlit'/'normals'/'depth' shading swaps
    // in MeshBasicMaterial/MeshNormalMaterial/MeshDepthMaterial (see
    // mesh-shading.ts), and 'wireframe'/'points' render modes have no solid
    // surface to receive a shadow on regardless of shading.
    const { shading, renderMode } = session;
    const shadowsUnsupported =
      shading === 'unlit' ||
      shading === 'normals' ||
      shading === 'depth' ||
      renderMode === 'wireframe' ||
      renderMode === 'points';
    this.els.shadowsCheckbox.disabled = shadowsUnsupported;
    this.els.shadowsCheckbox.title = shadowsUnsupported ? 'Shadows need a lit shading mode' : '';

    if (this.els.cinematicOptionsRow) setHidden(this.els.cinematicOptionsRow, quality !== 'cinematic');
    // Only sync the sub-toggles FROM session state while cinematic is
    // actually the active tier. These checkboxes represent "what to enable
    // once cinematic is selected," not "what's on right now" -- syncing
    // them from session.cinematic (which is `false` under flat/photo)
    // whenever the tier isn't cinematic would force them all off on every
    // attach()/refresh() before the user ever gets to choose, silently
    // discarding both the host's HTML defaults and the user's own choices
    // made while a different tier was selected.
    const cinematic = session.cinematic;
    if (cinematic !== false) {
      if (this.els.bloomCheckbox) this.els.bloomCheckbox.checked = cinematic.bloom !== false;
      if (this.els.aoCheckbox) this.els.aoCheckbox.checked = cinematic.ao !== false;
      if (this.els.dofCheckbox) this.els.dofCheckbox.checked = cinematic.dof !== false;
    }

    if (this.els.photoModeRow) setHidden(this.els.photoModeRow, quality !== 'photo');
    if (quality === 'photo') this.refreshPhotoModeStatus();
    else this.stopPhotoModePoll();

    // Turntable.step() moves the camera by writing controls.object.position
    // directly, without firing the controls 'change' event (deliberately —
    // see turntable.ts's own doc comment on why that's safe for
    // renderNow()-driven capture) — but that means photo mode's
    // updateCamera() reset hook (wired to that same event) never fires
    // during a turntable recording, so the path tracer keeps accumulating
    // over a moving camera instead of resetting each frame. Recording is
    // broken under the photo tier, not merely slow; disable it there rather
    // than let it produce a smeared clip. Only touched when NOT actively
    // recording — runRecordTurntable()'s own try/finally owns the button's
    // disabled state for that window, and a refresh() firing mid-recording
    // (e.g. from an unrelated setModel()) must not re-enable it early.
    if (!this.recording) {
      const recordingBroken = quality === 'photo';
      this.els.recordTurntableBtn.disabled = recordingBroken;
      this.els.recordTurntableBtn.title = recordingBroken ? 'Turntable recording is not supported in photo mode' : '';
    }
  }
}

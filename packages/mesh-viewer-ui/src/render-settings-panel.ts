import {
  createPopover,
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

/** Same rationale as `mesh-settings-panel.ts`'s own copy — no dependency on a consumer project's local module. */
function setHidden(el: HTMLElement, hidden: boolean): void {
  el.classList.toggle('hidden', hidden);
}

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
 */
export class RenderSettingsPanel {
  private els: RenderSettingsPanelElements;
  private opts: RenderSettingsPanelOptions;
  private session: MeshSession | null = null;
  private teardown: Array<() => void> = [];
  private photoModeAvailable = true;
  private photoModePollTimer: ReturnType<typeof setInterval> | null = null;
  private recording = false;

  constructor(elements: RenderSettingsPanelElements, opts: RenderSettingsPanelOptions) {
    this.els = elements;
    this.opts = opts;
    setHidden(this.els.toggleBtn, true);
    setHidden(this.els.panel, true);
    this.bindStaticControls();
    void isPhotoModeAvailable().then((available) => {
      this.photoModeAvailable = available;
      this.refresh();
    });
  }

  private on(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.teardown.push(() => target.removeEventListener(type, fn));
  }

  private closePanel(): void {
    setHidden(this.els.panel, true);
  }

  /** Absent toggles default to on — a reduced panel with no per-effect controls gets the full cinematic bundle from selecting the tier alone. */
  private currentCinematicOptions(): CinematicOptions {
    return {
      bloom: this.els.bloomCheckbox && !this.els.bloomCheckbox.checked ? false : DEFAULT_CINEMATIC.bloom,
      ao: this.els.aoCheckbox && !this.els.aoCheckbox.checked ? false : DEFAULT_CINEMATIC.ao,
      dof: this.els.dofCheckbox && !this.els.dofCheckbox.checked ? false : DEFAULT_CINEMATIC.dof,
    };
  }

  private applyQuality(): void {
    if (!this.session) return;
    const quality = this.els.qualitySelect.value as RenderQuality;
    if (quality !== 'photo') void this.session.setPhotoMode(false);
    if (quality !== 'cinematic') this.session.setCinematic(false);
    if (quality === 'cinematic') this.session.setCinematic(this.currentCinematicOptions());
    if (quality === 'photo') void this.session.setPhotoMode({});
    this.refresh();
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
    if (phase === 'tracing' || phase === 'loading') this.startPhotoModePoll();
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
        session.viewport.renderNow();
      },
    };
    try {
      const result = await recordClip(source, {
        driver: { start() {}, stop() {} },
        fps,
        durationSeconds,
        watermark: { text: this.opts.watermarkText(session) },
      });
      downloadClip(result, this.opts.fileName?.(session) ?? 'model');
    } finally {
      turntable.dispose();
      this.recording = false;
      this.els.recordTurntableBtn.disabled = false;
    }
  }

  private bindStaticControls(): void {
    this.teardown.push(createPopover(this.els.toggleBtn, this.els.panel));

    this.on(this.els.qualitySelect, 'change', () => this.applyQuality());
    this.on(this.els.shadowsCheckbox, 'change', () => {
      this.session?.setShadows(this.els.shadowsCheckbox.checked);
    });
    if (this.els.bloomCheckbox) this.on(this.els.bloomCheckbox, 'change', () => this.applyCinematicOptions());
    if (this.els.aoCheckbox) this.on(this.els.aoCheckbox, 'change', () => this.applyCinematicOptions());
    if (this.els.dofCheckbox) this.on(this.els.dofCheckbox, 'change', () => this.applyCinematicOptions());

    this.on(this.els.screenshotBtn, 'click', () => void this.runScreenshot());
    this.on(this.els.recordTurntableBtn, 'click', () => void this.runRecordTurntable());
  }

  /** Points the panel at `session` and shows the toolbar toggle button. Does not open the panel itself — mirrors `MeshSettingsPanel.attach()`. */
  attach(session: MeshSession): void {
    this.session = session;
    setHidden(this.els.toggleBtn, false);
    this.refresh();
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
  }

  /** Closes the panel, hides the toolbar toggle button, stops the photo-mode status poll, and releases the session reference. Does not touch the session itself. */
  detach(): void {
    this.stopPhotoModePoll();
    this.session = null;
    this.closePanel();
    setHidden(this.els.toggleBtn, true);
  }

  /** Tears down the controller itself — unbinds every listener bound in the constructor. */
  dispose(): void {
    this.stopPhotoModePoll();
    this.session = null;
    for (const off of this.teardown) off();
    this.teardown = [];
  }
}

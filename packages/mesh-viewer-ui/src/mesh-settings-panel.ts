import { createPopover } from '@seer-project/canvas-export';
import {
  supportedRenderModes,
  type MeshSession,
  type RenderMode,
  type MeshShadingMode,
  type TextureFilterMode,
} from '@seer-project/engine-3d';

/** Shows/hides an element via the `.hidden { display: none }` class every seer project's own `viewer.css` already defines — re-implemented here (rather than imported) so this package has no dependency on any consumer project's local module, same rationale as `@seer-project/audio-ui`'s own copy. */
function setHidden(el: HTMLElement, hidden: boolean): void {
  el.classList.toggle('hidden', hidden);
}

/**
 * The DOM elements one settings panel is built from — a toolbar toggle
 * button plus the popover panel it opens, and every control inside it. The
 * host owns all of this markup (and its layout/styling); this controller
 * only wires behavior to it, the same division of labor as
 * `@seer-project/audio-ui`'s `AudioBarController`.
 */
export interface MeshSettingsPanelElements {
  /** Toolbar button that opens/closes `panel`. Hidden by `detach()`, shown by `attach()`. */
  toggleBtn: HTMLButtonElement;
  /** The popover itself. Hidden until `toggleBtn` is clicked; closes on an outside click, Escape, or `detach()`. */
  panel: HTMLElement;
  renderModeSelect: HTMLSelectElement;
  smoothCheckbox: HTMLInputElement;
  shadingSelect: HTMLSelectElement;
  subdivideSelect: HTMLSelectElement;
  /** `<option>` values must be exactly `'nearest'\|'linear'\|'trilinear'` — see `TextureFilterMode`. */
  textureFilterSelect: HTMLSelectElement;
  /** Its `<option>`s are rebuilt by `refresh()` (powers of two up to the attached session's `getMaxAnisotropy()`) — the host only needs to create the empty `<select>`. */
  anisotropySelect: HTMLSelectElement;
  resetCameraBtn: HTMLButtonElement;
}

export interface MeshSettingsPanelOptions {
  /**
   * Called instead of the default `session.fit()` when the reset-camera
   * button is clicked. A host with its own per-asset camera persistence
   * (e.g. a localStorage entry keyed by asset path) typically clears that
   * entry, calls `session.fit()` itself, then re-saves the freshly-fit
   * camera state — all of which is host-specific storage strategy this
   * package deliberately doesn't own.
   */
  onResetCamera?: (session: MeshSession) => void;
}

/**
 * Generic, session-agnostic controller for the mesh viewer's "additional 3D
 * render options" — render mode, shading override, smooth/flat normals,
 * subdivision, texture filtering + anisotropy, and reset-camera — collected
 * into one togglable settings panel instead of a row of individual toolbar
 * controls. Wires a fixed set of DOM elements once, in the constructor;
 * `attach(session)` points it at whichever `MeshSession` the host just
 * loaded a model into, and `refresh()` re-syncs every control's displayed
 * value/disabled-state from that session's current state — call it again
 * after `session.setModel()` resolves, since a session's `renderMode`/
 * `shading`/etc. reset on every model load (see `@seer-project/engine-3d`'s
 * `MeshSession.setModel` docs).
 *
 * One controller instance is meant to live for the lifetime of the page
 * (constructed once against the toolbar's static markup) and have
 * `attach()`/`refresh()`/`detach()` called across asset selections — the
 * same pattern as `AudioBarController`.
 */
export class MeshSettingsPanel {
  private els: MeshSettingsPanelElements;
  private opts: MeshSettingsPanelOptions;
  private session: MeshSession | null = null;
  private teardown: Array<() => void> = [];

  constructor(elements: MeshSettingsPanelElements, opts: MeshSettingsPanelOptions = {}) {
    this.els = elements;
    this.opts = opts;
    setHidden(this.els.toggleBtn, true);
    setHidden(this.els.panel, true);
    this.bindStaticControls();
  }

  private on(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.teardown.push(() => target.removeEventListener(type, fn));
  }

  private closePanel(): void {
    setHidden(this.els.panel, true);
  }

  private bindStaticControls(): void {
    // Toggle-click / outside-click / Escape-to-close is shared chrome —
    // see @seer-project/canvas-export's createPopover, extracted from this
    // panel's own original implementation.
    this.teardown.push(createPopover(this.els.toggleBtn, this.els.panel));

    this.on(this.els.renderModeSelect, 'change', () => {
      this.session?.setRenderMode(this.els.renderModeSelect.value as RenderMode);
    });
    this.on(this.els.smoothCheckbox, 'change', () => {
      this.session?.setSmooth(this.els.smoothCheckbox.checked);
    });
    this.on(this.els.shadingSelect, 'change', () => {
      this.session?.setShading(this.els.shadingSelect.value as MeshShadingMode);
    });
    this.on(this.els.subdivideSelect, 'change', () => {
      this.session?.setSubdivision(Number(this.els.subdivideSelect.value));
    });
    this.on(this.els.textureFilterSelect, 'change', () => this.applyTextureFilterFromControls());
    this.on(this.els.anisotropySelect, 'change', () => this.applyTextureFilterFromControls());

    this.on(this.els.resetCameraBtn, 'click', () => {
      if (!this.session) return;
      if (this.opts.onResetCamera) this.opts.onResetCamera(this.session);
      else this.session.fit();
    });
  }

  private applyTextureFilterFromControls(): void {
    if (!this.session) return;
    const mode = this.els.textureFilterSelect.value as TextureFilterMode;
    this.els.anisotropySelect.disabled = mode === 'nearest';
    this.session.setTextureFilter({ mode, anisotropy: Number(this.els.anisotropySelect.value) });
  }

  /** Rebuilds `anisotropySelect`'s `<option>`s as powers of two up to the attached session's `getMaxAnisotropy()` — a device with no anisotropic filtering support (max `1`) ends up with just `Off`. Preserves the previously-selected value when it's still in range. */
  private refreshAnisotropyOptions(): void {
    if (!this.session) return;
    const max = Math.max(1, Math.floor(this.session.getMaxAnisotropy()));
    const levels: number[] = [1];
    for (let level = 2; level <= max; level *= 2) levels.push(level);
    if (max > 1 && levels[levels.length - 1] !== max) levels.push(max);

    const select = this.els.anisotropySelect;
    const previous = select.value;
    select.innerHTML = '';
    for (const level of levels) {
      const opt = document.createElement('option');
      opt.value = String(level);
      opt.textContent = level === 1 ? 'Off' : `${level}×`;
      select.appendChild(opt);
    }
    if (levels.includes(Number(previous))) select.value = previous;
  }

  /**
   * Points the panel at `session` and shows the toolbar toggle button.
   * Does not open the panel itself — call `refresh()` (directly, or via
   * `attach()`'s own call) once the session actually has a model loaded so
   * the render-mode `<option>`s' disabled state and every control's
   * displayed value reflect it.
   */
  attach(session: MeshSession): void {
    this.session = session;
    setHidden(this.els.toggleBtn, false);
    this.refresh();
  }

  /**
   * Re-syncs every control's displayed value (and the render-mode
   * `<option>`s' disabled state, and the anisotropy `<option>` list) from
   * the attached session's current state. No-op if nothing is attached.
   * Call this again after `session.setModel()` resolves — a session's
   * `renderMode`/`shading`/`smooth`/`subdivision` all reset on every model
   * load (`textureFilter` does not — it's a persisted viewer-wide
   * preference, see `MeshSession.setTextureFilter`'s docs).
   */
  refresh(): void {
    if (!this.session) return;
    const { session } = this;
    const model = session.model;

    if (session.renderMode) this.els.renderModeSelect.value = session.renderMode;
    if (model) {
      const supported = supportedRenderModes(model);
      for (const opt of Array.from(this.els.renderModeSelect.options)) {
        opt.disabled = !supported.includes(opt.value as RenderMode);
      }
    }

    this.els.smoothCheckbox.checked = session.smooth;
    this.els.shadingSelect.value = session.shading;
    this.els.subdivideSelect.value = String(session.subdivision);

    this.refreshAnisotropyOptions();
    this.els.textureFilterSelect.value = session.textureFilter.mode;
    this.els.anisotropySelect.value = String(session.textureFilter.anisotropy ?? 1);
    this.els.anisotropySelect.disabled = session.textureFilter.mode === 'nearest';
  }

  /** Closes the panel, hides the toolbar toggle button, and releases the session reference. Call on every asset switch away from a mesh (mirrors `AudioBarController.detach()`) — does not touch the session itself (a host still owns disposing it). */
  detach(): void {
    this.session = null;
    this.closePanel();
    setHidden(this.els.toggleBtn, true);
  }

  /** Tears down the controller itself — unbinds every listener bound in the constructor (including the document-level outside-click/Escape handlers). Call when the panel's elements are being removed from the page entirely; not needed for ordinary asset-to-asset switching (use `detach()`/`attach()` for that). */
  dispose(): void {
    this.session = null;
    for (const off of this.teardown) off();
    this.teardown = [];
  }
}
